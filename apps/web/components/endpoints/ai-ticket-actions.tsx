'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, Sparkles, Ticket } from 'lucide-react';
import { aiApi, psaApi, type AiAnswer, type AiStatus, type EntrySource, type PsaTicketResult, type PsaTicketStatus } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiError } from '@/components/security-controls/shared';

/**
 * Ask AI and Create ticket (0.48), on an event-log entry or an alert. Both
 * buttons name the entry by reference (a stored event-log result and its
 * index, or an alert id): the server reads the text itself, so neither can
 * be used to send arbitrary text anywhere.
 *
 * The AI's answer is shown as text. A tiny markdown subset (headings, bold,
 * bullets) is drawn with React elements; nothing is ever inserted as HTML
 * and links are left as plain text.
 */

export const NOT_CONFIGURED_AI = 'Not configured — a Platform Admin sets a provider in Settings → AI';

export function useAiStatus() {
  return useQuery<AiStatus>({ queryKey: ['ai-status'], queryFn: () => aiApi.status().then((r) => r.data.data), staleTime: 60_000, retry: false });
}
export function useTicketStatus(endpointId: string) {
  return useQuery<PsaTicketStatus>({ queryKey: ['psa-ticket-status', endpointId], queryFn: () => psaApi.ticketStatus(endpointId).then((r) => r.data.data), staleTime: 60_000, retry: false });
}

export const sourceRefOf = (s: EntrySource) => (s.source === 'event' ? `event:${s.commandId}:${s.index}` : `alert:${s.alertId}`);

/** Bold spans only; everything else stays text. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
}

const HEADINGS = /^(what it means|likely causes|does it matter|safe next steps)\s*:?\s*$/i;

export function SafeAnswer({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={`u${blocks.length}`} className="ml-5 list-disc space-y-0.5">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    if (!line.trim()) continue;
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const plainHeading = line.replace(/^\*\*(.*)\*\*:?$/, '$1');
    if (h || HEADINGS.test(plainHeading)) { blocks.push(<p key={`h${blocks.length}`} className="pt-1 font-semibold">{(h ? h[1] : plainHeading).replace(/\*\*/g, '')}</p>); continue; }
    blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-1.5 text-sm break-words">{blocks}</div>;
}

export function AskAiButton({ endpointId, source }: { endpointId: string; source: EntrySource }) {
  const { data: status } = useAiStatus();
  const [open, setOpen] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const ask = useMutation({ mutationFn: () => aiApi.explain(endpointId, source).then((r) => r.data.data as AiAnswer) });
  const preview = useQuery<{ text: string; chars: number; redactions: Record<string, number> }>({
    queryKey: ['ai-preview', endpointId, sourceRefOf(source)], queryFn: () => aiApi.preview(endpointId, source).then((r) => r.data.data), enabled: open && showSent, retry: false,
  });
  const qc = useQueryClient();
  const enabled = !!status?.enabled;
  const start = () => { setOpen(true); if (!ask.data && !ask.isPending) ask.mutate(undefined, { onSuccess: () => qc.invalidateQueries({ queryKey: ['psa-draft', endpointId, sourceRefOf(source)] }) }); };
  const removed = ask.data ? Object.values(ask.data.redactions).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!enabled} title={enabled ? `Ask ${status?.providerLabel ?? 'the AI'} what this means` : NOT_CONFIGURED_AI} onClick={start}>
        <Sparkles className="mr-1 h-3 w-3" />Ask AI
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">AI explanation {ask.data?.cached && <Badge variant="outline">cached</Badge>}</DialogTitle>
            <DialogDescription>
              {ask.data ? `${status?.providerLabel ?? ask.data.provider} · ${ask.data.model}` : status?.providerLabel ?? ''}. Redacted before sending: names, addresses, accounts and serials were removed{ask.data ? ` (${removed} value${removed === 1 ? '' : 's'})` : ''}. AI can be wrong — check before acting.
            </DialogDescription>
          </DialogHeader>
          {ask.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Asking… this can take up to a minute.</p>}
          {ask.error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{apiError(ask.error).message}</p> : null}
          {ask.data && <SafeAnswer text={ask.data.answer} />}
          <div className="space-y-2">
            <button className="text-xs text-muted-foreground underline" onClick={() => setShowSent((v) => !v)}>{showSent ? 'Hide what was sent' : 'Show what was sent'}</button>
            {showSent && (preview.data
              ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-xs">{preview.data.text}</pre>
              : preview.error ? <p className="text-xs text-muted-foreground">{apiError(preview.error).message}</p> : <p className="text-xs text-muted-foreground">Loading…</p>)}
          </div>
          <DialogFooter className="gap-2">
            {ask.error ? <Button variant="outline" onClick={() => ask.mutate()}>Try again</Button> : null}
            <Button variant="outline" disabled={!ask.data} onClick={() => { if (ask.data) void navigator.clipboard?.writeText(ask.data.answer).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
              <Copy className="mr-1 h-3 w-3" />{copied ? 'Copied' : 'Copy'}
            </Button>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CreateTicketButton({ endpointId, source }: { endpointId: string; source: EntrySource }) {
  const qc = useQueryClient();
  const { data: status } = useTicketStatus(endpointId);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [includeAi, setIncludeAi] = useState(false);
  const ref = sourceRefOf(source);
  const draft = useQuery<{ subject: string; aiAvailable: boolean }>({
    queryKey: ['psa-draft', endpointId, ref], queryFn: () => psaApi.draft(endpointId, source).then((r) => r.data.data), enabled: open, retry: false,
  });
  const send = useMutation({
    mutationFn: () => psaApi.create(endpointId, { ...source, subject: (subject ?? draft.data?.subject ?? '').trim() || undefined, note: note.trim() || undefined, includeAi }).then((r) => r.data.data as PsaTicketResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['psa-ticket-status', endpointId] }),
  });
  // Standalone (docs/ux/STANDALONE_REQUIREMENTS.md): no PSA connected means the
  // button could never work, so it is not drawn. A connector that is paused or
  // not ready keeps the disabled button and its reason.
  if (!status || !status.canCreate || !status.connector) return null;
  const existing = status.tickets.find((t) => t.sourceRef === ref);
  const why = !status.available ? status.reason ?? 'Ticketing is not available.' : null;
  const close = (v: boolean) => { setOpen(v); if (!v) { send.reset(); setSubject(null); setNote(''); setIncludeAi(false); } };
  return (
    <>
      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!!why} title={why ?? `Create a ticket in ${status.connector?.label || status.connector?.kindLabel}`} onClick={() => setOpen(true)}>
        <Ticket className="mr-1 h-3 w-3" />{existing ? 'Ticket again' : 'Create ticket'}
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create ticket</DialogTitle>
            <DialogDescription>
              Sent to {status.connector?.label || status.connector?.kindLabel} ({status.connector?.scope === 'business' ? "this business's connector" : 'the platform default'}). The ticket names the computer and business and carries the entry and a link to this computer.
            </DialogDescription>
          </DialogHeader>
          {send.data ? (
            <div className="space-y-2 text-sm">
              <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
                Ticket created in {send.data.kindLabel}{send.data.ref ? ` · ${send.data.ref}` : ' (the PSA returned no reference)'}.
              </p>
              {send.data.url && <p className="break-all text-xs text-muted-foreground">{send.data.url}</p>}
              <p className="text-xs text-muted-foreground">A note was added to this computer&apos;s History.</p>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {existing && <p className="text-xs text-amber-700 dark:text-amber-300">A ticket was already created for this entry{existing.ref ? ` (${existing.ref})` : ''} on {new Date(existing.createdAt).toLocaleString()}.</p>}
              <div className="space-y-1">
                <Label htmlFor="ticket-subject">Subject</Label>
                <Input id="ticket-subject" maxLength={200} value={subject ?? draft.data?.subject ?? ''} placeholder={draft.isLoading ? 'Loading…' : ''} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ticket-note">Note (optional)</Label>
                <Textarea id="ticket-note" rows={4} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={!draft.data?.aiAvailable} checked={includeAi && !!draft.data?.aiAvailable} onChange={(e) => setIncludeAi(e.target.checked)} />
                Include AI explanation
                {!draft.data?.aiAvailable && <span className="text-xs text-muted-foreground">(ask AI about this entry first)</span>}
              </label>
              {draft.error ? <p className="text-xs text-destructive">{apiError(draft.error).message}</p> : null}
              {send.error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">{apiError(send.error).message}</p> : null}
            </div>
          )}
          <DialogFooter className="gap-2">
            {send.data ? <Button onClick={() => close(false)}>Done</Button> : (
              <>
                <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
                <Button disabled={send.isPending || !draft.data} onClick={() => send.mutate()}>{send.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}Send</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Ticket created · ref" for an entry that already has one. */
export function TicketBadge({ endpointId, source }: { endpointId: string; source: EntrySource }) {
  const { data } = useTicketStatus(endpointId);
  const t = data?.tickets.find((x) => x.sourceRef === sourceRefOf(source));
  if (!t) return null;
  return <Badge variant="secondary" className="text-[11px]" title={t.url ?? undefined}>Ticket created{t.ref ? ` · ${t.ref}` : ''}</Badge>;
}

/** Both buttons and the badge, for one row. */
export function EntryActions({ endpointId, source }: { endpointId: string; source: EntrySource }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AskAiButton endpointId={endpointId} source={source} />
      <CreateTicketButton endpointId={endpointId} source={source} />
      <TicketBadge endpointId={endpointId} source={source} />
    </div>
  );
}
