'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpointsApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { ago } from './device-model';

/**
 * Chat (0.34; the tray, 0.36): the technician side of a chat with the person
 * at this computer. The other side is the tray's chat window on Windows (the
 * portal's /assist page), headed with the business name and the technician's
 * name; the person can also start a chat from the tray.
 *
 * Recorded or not (0.36) is fixed when the chat starts, from the business's
 * setting. A chat that is not recorded keeps a message on the server only
 * until both sides have it: this panel keeps its own copy for as long as the
 * page is open, and acknowledges the person's replies once shown (which is
 * what lets the server delete them).
 *
 * Everything here is what the server says: whether this computer can chat
 * (and if not, why), whether a containment pause stops it, where the chat
 * stands on the computer (presence, as the agent last reported it), and
 * each message's receipt — sent, delivered to the agent, shown, read — set
 * only when the agent confirms it. Message text is rendered as React text:
 * escaped, never HTML, and never turned into a link.
 */

type Presence = { code: string; text: string };
type Conversation = {
  id: string; status: 'OPEN' | 'ENDED'; technicianName: string; businessName: string; supportRequestId: string | null;
  startedBy: 'technician' | 'end_user'; recorded: boolean;
  deviceUser: string | null; deviceDetail: string | null; createdAt: string; endedAt: string | null; endedReason: string | null;
  technicianMessages: number; endUserMessages: number; presence: Presence;
};
type Message = {
  id: string; sender: 'TECHNICIAN' | 'END_USER'; authorName: string; body: string; createdAt: string;
  deliveredAt: string | null; shownAt: string | null; readAt: string | null; receipt: 'sent' | 'delivered' | 'shown' | 'read' | null;
};
type Overview = {
  support: { supported: true; via: 'window' | 'tray' } | { supported: false; reason: string; message: string };
  recordNew: boolean;
  canSend: boolean;
  contained: { pauseId: string; message: string } | null;
  lastSignedInUser: { name: string | null; at: string } | null;
  open: Conversation | null;
  conversations: Conversation[];
  limits: { maxChars: number; perMinute: number; retentionDays: number };
};

const RECEIPT: Record<NonNullable<Message['receipt']>, string> = {
  sent: 'Sent — not yet confirmed by the computer',
  delivered: 'Delivered to the agent',
  shown: 'Shown on screen',
  read: 'Read (shown while the window was in front)',
};

const PRESENCE_TONE: Record<string, string> = {
  window_open: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  no_user: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  window_closed: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  window_failed: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
  computer_silent: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
};

function apiError(e: unknown, fallback: string) {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof m === 'string' ? m : fallback;
}

function time(at: string) {
  return new Date(at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

function Transcript({ endpointId, conversationId, live, canAck }: { endpointId: string; conversationId: string; live: boolean; canAck: boolean }) {
  const { data, isLoading, isError } = useQuery<{ conversation: Conversation; messages: Message[]; truncated: boolean; recorded: boolean }>({
    queryKey: ['chat-transcript', endpointId, conversationId],
    queryFn: () => endpointsApi.chatTranscript(endpointId, conversationId).then((r) => r.data?.data),
    refetchInterval: live ? 3000 : false,
  });
  // Not recorded (0.36): the server deletes a message once both sides have it,
  // so this panel keeps what it has seen, for as long as the page is open.
  const kept = useRef<Map<string, Message>>(new Map());
  const acked = useRef<Set<string>>(new Set());
  const recorded = data?.recorded ?? true;
  if (data && !recorded) for (const m of data.messages) kept.current.set(m.id, m);
  const messages = !data ? [] : recorded ? data.messages : Array.from(kept.current.values());
  const toAck = !data || recorded || !canAck || !live ? [] : data.messages.filter((m) => m.sender === 'END_USER' && !acked.current.has(m.id)).map((m) => m.id);
  const ackKey = toAck.join(',');
  useEffect(() => {
    if (!ackKey) return;
    const ids = ackKey.split(',');
    ids.forEach((id) => acked.current.add(id));
    endpointsApi.chatAck(endpointId, conversationId, ids).catch(() => ids.forEach((id) => acked.current.delete(id)));
  }, [ackKey, endpointId, conversationId]);
  const end = useRef<HTMLDivElement>(null);
  const count = messages.length;
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [count]);
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">The transcript could not be loaded.</p>;
  return (
    <div className="max-h-[420px] overflow-y-auto rounded-md border bg-muted/20 p-3 space-y-3" data-testid="chat-transcript" data-recorded={recorded ? 'yes' : 'no'}>
      {!recorded && (
        <p className="text-xs text-muted-foreground" data-testid="chat-not-recorded-note">
          This chat is not recorded. The server deletes each message once both sides have it; what you see here is this page&apos;s own copy and is gone when you leave it.
          {!canAck && ' Replies are deleted only once the technician in the chat has seen them.'}
        </p>
      )}
      {data.truncated && <p className="text-xs text-muted-foreground">Showing the newest 500 messages.</p>}
      {messages.length === 0 && <p className="text-sm text-muted-foreground">{recorded ? 'No messages yet.' : 'No messages on this page yet.'}</p>}
      {messages.map((m) => {
        const mine = m.sender === 'TECHNICIAN';
        return (
          <div key={m.id} className={mine ? 'flex flex-col items-end' : 'flex flex-col items-start'} data-testid="chat-message">
            <div className="text-[11px] text-muted-foreground">
              {mine ? m.authorName : `${m.authorName} (at the computer)`} · {time(m.createdAt)}
            </div>
            <div className={`mt-0.5 max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${mine ? 'bg-primary text-primary-foreground' : 'bg-background border'}`}>
              {m.body}
            </div>
            {mine && m.receipt && (
              <div className="mt-0.5 text-[11px] text-muted-foreground" data-testid="chat-receipt" data-receipt={m.receipt}
                title={[m.deliveredAt && `Delivered ${time(m.deliveredAt)}`, m.shownAt && `Shown ${time(m.shownAt)}`, m.readAt && `Read ${time(m.readAt)}`].filter(Boolean).join(' · ') || undefined}>
                {RECEIPT[m.receipt]}
              </div>
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

export function DeviceChatTab({ endpointId }: { endpointId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery<Overview>({
    queryKey: ['chat', endpointId],
    queryFn: () => endpointsApi.chat(endpointId).then((r) => r.data?.data),
    refetchInterval: (q) => ((q.state.data as Overview | undefined)?.open ? 5000 : 30_000),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['chat', endpointId] });
    void qc.invalidateQueries({ queryKey: ['chat-transcript', endpointId] });
  };
  const start = useMutation({
    mutationFn: () => endpointsApi.chatStart(endpointId),
    onSuccess: () => { setViewing(null); refresh(); },
    onError: (e) => toast({ title: 'Chat not started', description: apiError(e, 'The chat could not be started.'), variant: 'destructive' }),
  });
  const send = useMutation({
    mutationFn: ({ cid, body }: { cid: string; body: string }) => endpointsApi.chatSend(endpointId, cid, body),
    onSuccess: () => { setText(''); refresh(); },
    onError: (e) => toast({ title: 'Not sent', description: apiError(e, 'The message was not sent.'), variant: 'destructive' }),
  });
  const endChat = useMutation({
    mutationFn: (cid: string) => endpointsApi.chatEnd(endpointId, cid),
    onSuccess: refresh,
    onError: (e) => toast({ title: 'Error', description: apiError(e, 'The chat could not be ended.'), variant: 'destructive' }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">Chat could not be loaded for this computer.</p>;

  const open = data.open;
  const max = data.limits.maxChars;
  const tooLong = text.length > max;
  const mayWrite = data.canSend && !data.contained;
  const past = data.conversations.filter((c) => c.status === 'ENDED');

  return (
    <div className="space-y-4" data-testid="chat-tab">
      {!data.support.supported && (
        <Card data-testid="chat-unsupported">
          <CardContent className="pt-6 text-sm">
            <p className="font-medium">Chat is not available on this computer.</p>
            <p className="mt-1 text-muted-foreground">{data.support.message}</p>
          </CardContent>
        </Card>
      )}

      {data.contained && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200" data-testid="chat-contained">
          {data.contained.message} New chats and new messages are stopped until the pause is lifted.
        </div>
      )}

      {open ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle className="text-sm">
                Chat as {open.technicianName} for {open.businessName}
              </CardTitle>
              <span className="text-xs text-muted-foreground">Started {ago(open.createdAt)}</span>
            </div>
            <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${PRESENCE_TONE[open.presence.code] ?? 'border-border bg-muted/40'}`} data-testid="chat-presence" data-presence={open.presence.code}>
              {open.presence.text}
              {open.presence.code === 'window_open' && open.deviceUser && <> Signed in: <span className="font-medium">{open.deviceUser}</span>.</>}
              {open.presence.code === 'window_failed' && open.deviceDetail && <> ({open.deviceDetail})</>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs text-muted-foreground" data-testid="chat-recorded" data-recorded={open.recorded ? 'yes' : 'no'}>
              {open.recorded
                ? `This chat is recorded: the transcript is kept for ${data.limits.retentionDays} days after it ends. The person at the computer is told so.`
                : 'This chat is not recorded: messages are deleted once both sides have them, and everything left when it ends. The person at the computer is told so.'}
              {open.startedBy === 'end_user' && ' The person at the computer started this chat from the tray.'}
            </div>
            <Transcript endpointId={endpointId} conversationId={open.id} live canAck={data.canSend} />
            {mayWrite ? (
              <form
                className="space-y-2"
                onSubmit={(e) => { e.preventDefault(); if (text.trim() && !tooLong) send.mutate({ cid: open.id, body: text }); }}
              >
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim() && !tooLong) send.mutate({ cid: open.id, body: text }); } }}
                  placeholder="Write to the person at the computer (Enter sends, Shift+Enter for a new line)"
                  rows={3}
                  data-testid="chat-input"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-xs tabular-nums ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {text.length} / {max} · at most {data.limits.perMinute} messages a minute
                  </span>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => endChat.mutate(open.id)} disabled={endChat.isPending} data-testid="chat-end">
                      End chat
                    </Button>
                    <Button type="submit" size="sm" disabled={!text.trim() || tooLong || send.isPending} data-testid="chat-send">
                      Send
                    </Button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{data.contained ? 'Writing is paused.' : 'You can read this chat. Writing in it needs the "Chat with the person at a computer" permission.'}</span>
                {data.canSend && (
                  <Button type="button" variant="outline" size="sm" onClick={() => endChat.mutate(open.id)} disabled={endChat.isPending}>End chat</Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ) : data.support.supported && (
        <Card>
          <CardContent className="pt-6 space-y-3 text-sm">
            <p>
              {data.support.via === 'tray'
                ? <>Starting a chat opens the tray&apos;s chat window on this computer, headed with the business name and your name. The person there can reply, close it and reopen it from the tray icon. The computer learns of the chat at its next check-in, normally within three minutes.</>
                : <>Starting a chat opens a small window on this computer&apos;s desktop, headed with the business name and your name. The person there can reply or close it. The computer picks the chat up at its next check-in, normally within three minutes.</>}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="chat-record-new" data-recorded={data.recordNew ? 'yes' : 'no'}>
              {data.recordNew
                ? `A chat started now is recorded: its transcript is kept for ${data.limits.retentionDays} days after it ends.`
                : 'A chat started now is not recorded: messages are deleted once both sides have them.'}
            </p>
            {data.lastSignedInUser && (
              <p className="text-xs text-muted-foreground">
                At the last check-in ({ago(data.lastSignedInUser.at)}), {data.lastSignedInUser.name ? <>{data.lastSignedInUser.name} was signed in</> : 'nobody was signed in'}.
                The chat window reports who it opened for once it is up.
              </p>
            )}
            {data.canSend ? (
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending || !!data.contained} data-testid="chat-start">
                Start chat
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Starting a chat needs the &ldquo;Chat with the person at a computer&rdquo; permission.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Earlier chats</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Transcripts belong to the computer: anyone who can see it can read them. They are deleted {data.limits.retentionDays} days after the chat ends. A chat that was not recorded keeps no transcript.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {past.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
          {past.map((c) => (
            <div key={c.id} className="rounded-md border p-2" data-testid="chat-past">
              <button type="button" className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left text-sm" onClick={() => setViewing(viewing === c.id ? null : c.id)}>
                <span>{time(c.createdAt)} · {c.technicianName}</span>
                <span className="text-xs text-muted-foreground">
                  {c.technicianMessages} sent · {c.endUserMessages} received · {c.recorded ? '' : 'not recorded · '}{c.presence.text}
                </span>
              </button>
              {viewing === c.id && <div className="mt-2"><Transcript endpointId={endpointId} conversationId={c.id} live={false} canAck={false} /></div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
