'use client';

/**
 * New-message alerts for chat (0.44), wherever the technician is in the
 * console: the chat icon in the top bar with an unread badge and a list of
 * open chats, a toast for each new reply from the person at a computer, an
 * optional sound, and the unread count in the document title.
 *
 * The app has no push channel, so this polls GET /chat/inbox every 10 s with
 * the version it last saw; while nothing moved the server answers
 * `unchanged` without counting anything. The server lists only open chats on
 * computers this user can see, with computers:view; the read marks are this
 * user's own (the chat panel sets them while it is in front). Every name and
 * preview is React text.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Volume2, VolumeX } from 'lucide-react';
import { chatInboxApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

type InboxChat = {
  conversationId: string; endpointId: string; computerName: string; businessName: string | null; startedBy: string;
  lastActivityAt: string; unread: number;
  latest: { id: string; at: string; preview: string; attachment: 'image' | 'file' | null; authorName: string } | null;
};
type Inbox = { version: string; chats: InboxChat[]; totalUnread: number };

export const OPEN_CHAT_EVENT = 'rem0te:open-chat';
const POLL_MS = 10_000;
const SOUND_KEY = 'rem0te.chatAlertSound';

function previewOf(c: InboxChat): string {
  const l = c.latest;
  if (!l) return c.startedBy === 'end_user' ? 'Started a chat from the tray.' : 'No reply yet.';
  if (l.attachment === 'image') return `📎 Sent a picture: ${l.preview}`;
  if (l.attachment === 'file') return `📎 Sent a file: ${l.preview}`;
  return l.preview.length >= 100 ? `${l.preview}…` : l.preview;
}

/** A short two-tone chime, made here: no audio file is fetched. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.2);
    });
    setTimeout(() => { void ctx.close(); }, 800);
  } catch { /* no audio */ }
}

const TITLE_PREFIX = /^\(\d+\) /;

export function ChatInbox() {
  const { can, user } = usePermissions();
  const enabled = !!user && can(CAP.COMPUTERS_VIEW);
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState(false);
  const last = useRef<Inbox | null>(null);
  const seen = useRef<Map<string, string> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { try { setSound(localStorage.getItem(SOUND_KEY) === 'on'); } catch { /* storage blocked */ } }, []);

  const { data } = useQuery<Inbox>({
    queryKey: ['chat-inbox'],
    enabled,
    // F-9 (0.87): a hidden tab still hears about a reply (the title count and the sound are for that), but at a quarter of the rate — 10 s polls from every open tab ran into the 30-a-minute limit.
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? POLL_MS * 4 : POLL_MS),
    refetchIntervalInBackground: true,
    retry: false,
    queryFn: async () => {
      const r = await chatInboxApi.get(last.current?.version);
      const d = r.data?.data as ({ version: string; unchanged: true } | (Inbox & { unchanged: false }));
      if (d?.unchanged && last.current) return last.current;
      const next: Inbox = { version: d.version, chats: 'chats' in d ? d.chats : [], totalUnread: 'totalUnread' in d ? d.totalUnread : 0 };
      last.current = next;
      return next;
    },
  });

  const openChat = useCallback((endpointId: string) => {
    setOpen(false);
    const here = window.location.pathname === `/endpoints/${endpointId}`;
    if (here) window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: { endpointId } }));
    else router.push(`/endpoints/${encodeURIComponent(endpointId)}?tab=chat`);
  }, [router]);

  // A toast (and the chime) for each chat whose newest reply is one this page
  // has not seen. The first answer only records what is already there: the
  // badge shows it, and a page load is not a new message.
  useEffect(() => {
    if (!data) return;
    const prev = seen.current;
    const now = new Map(data.chats.map((c) => [c.conversationId, c.latest?.id ?? `start:${c.startedBy}`]));
    seen.current = now;
    if (!prev) return;
    let rang = false;
    for (const c of data.chats) {
      const was = prev.get(c.conversationId);
      const is = now.get(c.conversationId);
      const fresh = was !== is && (c.unread > 0 || (!was && c.startedBy === 'end_user'));
      if (!fresh) continue;
      const watching = document.visibilityState === 'visible' && window.location.pathname === `/endpoints/${c.endpointId}`
        && new URLSearchParams(window.location.search).get('tab') === 'chat';
      if (watching) continue;
      toast({
        title: `${c.computerName}${c.businessName ? ` · ${c.businessName}` : ''}`,
        description: (
          <span data-testid="chat-toast">
            {!was && c.startedBy === 'end_user' ? 'New chat from the tray: ' : ''}{previewOf(c)}
          </span>
        ),
        action: <ToastAction altText="Open the chat" onClick={() => openChat(c.endpointId)}>Open</ToastAction>,
        onClick: () => openChat(c.endpointId),
      });
      rang = true;
    }
    if (rang && sound) chime();
  }, [data, sound, toast, openChat]);

  // The unread count in the title, kept there as pages change it.
  const total = data?.totalUnread ?? 0;
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(TITLE_PREFIX, '');
      const want = total > 0 ? `(${total}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    const el = document.querySelector('title');
    if (!el) return;
    const mo = new MutationObserver(apply);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => { mo.disconnect(); document.title = document.title.replace(TITLE_PREFIX, ''); };
  }, [total, pathname]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!enabled) return null;
  const chats = data?.chats ?? [];
  const toggleSound = () => {
    const v = !sound;
    setSound(v);
    try { localStorage.setItem(SOUND_KEY, v ? 'on' : 'off'); } catch { /* storage blocked */ }
    if (v) chime();
  };
  return (
    <div className="relative ml-auto pl-2" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={total ? `Chats: ${total} unread` : 'Chats'}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="chat-inbox-trigger"
        data-unread={total}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MessageSquare className="h-5 w-5" />
        {total > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white" data-testid="chat-inbox-badge">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Open chats" data-testid="chat-inbox-panel"
          className="absolute right-0 top-11 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-sm font-semibold">Open chats</span>
            <button type="button" onClick={toggleSound} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" data-testid="chat-inbox-sound" aria-pressed={sound}>
              {sound ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              {sound ? 'Sound on' : 'Sound off'}
            </button>
          </div>
          {chats.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No open chats on computers you can see.</p>}
          <ul className="max-h-80 overflow-y-auto">
            {chats.map((c) => (
              <li key={c.conversationId}>
                <button type="button" onClick={() => openChat(c.endpointId)} data-testid="chat-inbox-item" data-unread={c.unread}
                  className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-accent">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.computerName}{c.businessName ? <span className="font-normal text-muted-foreground"> · {c.businessName}</span> : null}</span>
                    <span className="block truncate text-xs text-muted-foreground">{previewOf(c)}</span>
                  </span>
                  {c.unread > 0 && <span className="mt-0.5 shrink-0 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
