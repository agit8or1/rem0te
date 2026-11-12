/**
 * Chat (0.34): the rules, as pure functions. No Nest, no Prisma, so the unit
 * script (scripts/unit-chat.mjs) exercises exactly what the service runs.
 *
 * Everything the person at the computer types is untrusted: it is stored as
 * plain text after `chatText()`, rendered escaped by the console (React text,
 * never HTML), and never turned into a link anywhere — the desktop window is
 * a plain Win32 edit control, which has no link detection to turn on.
 */

/** Longest message, either side, in characters (UTF-16 code units, as the CHECK counts them near enough). */
export const MAX_MESSAGE_CHARS = 2000;
/** Messages one side may send in one conversation per minute. */
export const MAX_PER_MINUTE = { technician: 20, endUser: 20 } as const;
/** Messages a computer may post per minute, across every conversation it has. */
export const MAX_DEVICE_PER_MINUTE = 30;
/** Messages one conversation may hold in all. */
export const MAX_MESSAGES_PER_CONVERSATION = 1000;
/** How long the device's poll is held open when there is nothing new, at most. */
export const POLL_HOLD_MS = 25_000;
/** While a poll is held, the database is re-read this often (a second API process may have written). */
export const POLL_RECHECK_MS = 10_000;
/** Held polls across the whole process. Beyond this a poll returns at once and the agent backs off. */
export const DEFAULT_MAX_WAITERS = 500;
/** An open conversation with no message and no device poll for this long is ended as inactive. */
export const INACTIVE_MS = 2 * 60 * 60_000;
/** Messages handed to the device per poll. */
export const POLL_BATCH = 50;
/** Transcript rows returned per read. */
export const TRANSCRIPT_PAGE = 500;

// ── Retention ────────────────────────────────────────────────────────────────

export const RETENTION_DEFAULT_DAYS = 400;
const RETENTION_MIN_DAYS = 30;
const RETENTION_MAX_DAYS = 3650;

export interface ChatSweepConfig {
  enabled: boolean;
  retentionDays: number;
  sweepSeconds: number;
  /** Conversations deleted per batch, and batches per pass. */
  batch: number;
  batches: number;
  maxWaiters: number;
}

function bounded(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** From the environment, each value clamped: CHAT_RETENTION_DAYS cannot go below 30 days or past ten years. */
export function chatConfig(env: Record<string, string | undefined>): ChatSweepConfig {
  return {
    enabled: env.CHAT_RETENTION_SWEEP !== 'off',
    retentionDays: bounded(env.CHAT_RETENTION_DAYS, RETENTION_DEFAULT_DAYS, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS),
    sweepSeconds: bounded(env.CHAT_SWEEP_SECONDS, 3600, 2, 86_400),
    batch: bounded(env.CHAT_PRUNE_BATCH, 500, 1, 5000),
    batches: bounded(env.CHAT_PRUNE_BATCHES, 20, 1, 1000),
    maxWaiters: bounded(env.CHAT_MAX_WAITERS, DEFAULT_MAX_WAITERS, 1, 20_000),
  };
}

/** Ended before this instant → deleted, with its messages. */
export function retentionCutoff(now: number, days: number): Date {
  return new Date(now - days * 86_400_000);
}

// ── Text ─────────────────────────────────────────────────────────────────────

// C0 and C1 controls except tab and newline, DEL, the Unicode line and
// paragraph separators, and the bidirectional overrides and isolates that let
// text display in a different order from the one it is stored in.
const CONTROL_RANGES: [number, number][] = [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const isControl = (code: number) => CONTROL_RANGES.some(([a, b]) => code >= a && code <= b);
/** Every character in CONTROL_RANGES removed (or replaced by `by`). */
function stripControls(s: string, by = ''): string {
  let out = '';
  for (const ch of s) out += isControl(ch.codePointAt(0)!) ? by : ch;
  return out;
}

export type TextResult = { ok: true; text: string } | { ok: false; code: 'EMPTY' | 'TOO_LONG' | 'NOT_TEXT' };

/**
 * A message body as it is stored: CRLF and CR to LF, control characters
 * dropped, at most 20 consecutive blank lines, trimmed. Over the cap is
 * refused, never cut — a cut message says something the sender did not.
 */
export function chatText(raw: unknown): TextResult {
  if (typeof raw !== 'string') return { ok: false, code: 'NOT_TEXT' };
  const text = stripControls(raw.replace(/\r\n?/g, '\n')).replace(/\n{21,}/g, '\n'.repeat(20)).trim();
  if (!text) return { ok: false, code: 'EMPTY' };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, text };
}

/** A display name the agent reports (the Windows account), made inert: one line, 64 characters. */
export function deviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = stripControls(raw, ' ').replace(/[\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return s || null;
}

/** The technician's name as the desktop shows it. Never the email address: that is not theirs to publish. */
export function technicianDisplayName(u: { firstName?: string | null; lastName?: string | null }): string {
  const n = deviceName(`${u.firstName ?? ''} ${u.lastName ?? ''}`);
  return n ?? 'Technician';
}

// ── Device-reported state ─────────────────────────────────────────────────────

export const DEVICE_STATES = ['connecting', 'window_open', 'no_user', 'window_failed', 'user_closed'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

export function deviceState(raw: unknown): DeviceState | null {
  return typeof raw === 'string' && (DEVICE_STATES as readonly string[]).includes(raw) ? (raw as DeviceState) : null;
}

const ID_RE = /^[a-z0-9]{20,40}$/;
/** cuid-shaped ids only: everything the device sends back is checked before it reaches a query. */
export function idList(raw: unknown, max = POLL_BATCH * 2): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, max);
}
export const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const isClientId = (v: unknown): v is string => typeof v === 'string' && CLIENT_ID_RE.test(v);

// ── Can this computer chat? ──────────────────────────────────────────────────

export type ChatSupport =
  | { supported: true; via: 'window' | 'tray' }
  | { supported: false; reason: 'platform' | 'agent' | 'not_bound' | 'archived'; message: string };

/**
 * Whether the portal offers a chat on this computer, and how it reaches the
 * person there:
 *   - `tray` (0.36): the tray icon opens the /assist page. The signed agent
 *     reports chat protocol 2 (its tray is started by the agent); the standard
 *     agent reports a tray protocol once its tray is installed and paired.
 *   - `window` (0.34): a signed agent on chat protocol 1 draws the Win32 chat
 *     window. Agents of that build are still in the field; their routes stay.
 * Everything else says why not, in words the panel shows as they are.
 */
export function chatSupport(ep: {
  platform?: string | null; updateChannel?: string | null; chatProtocol?: number | null; status?: string | null; agentBound: boolean;
  trayProtocol?: number | null; trayPaired?: boolean;
}): ChatSupport {
  const p = String(ep.platform ?? '').toLowerCase();
  if (ep.status === 'ARCHIVED') {
    return { supported: false, reason: 'archived', message: 'This computer is archived.' };
  }
  if (/^(linux|macos|mac|darwin|osx)/.test(p)) {
    return { supported: false, reason: 'platform', message: `Chat is not available on ${p.startsWith('linux') ? 'Linux' : 'macOS'} yet: only the Windows agents have a tray and a chat window.` };
  }
  if (!ep.agentBound) {
    return { supported: false, reason: 'not_bound', message: 'This computer has never authenticated with a device secret. Re-run its installer before chatting.' };
  }
  if (ep.updateChannel === 'signed') {
    if ((ep.chatProtocol ?? 0) >= 2) return { supported: true, via: 'tray' };
    if ((ep.chatProtocol ?? 0) >= 1) return { supported: true, via: 'window' };
    return { supported: false, reason: 'agent', message: 'This computer\'s signed agent is too old to chat. Update it to 0.34 or later.' };
  }
  if ((ep.trayProtocol ?? 0) >= 1 && ep.trayPaired) return { supported: true, via: 'tray' };
  return {
    supported: false, reason: 'agent',
    message: 'This computer runs the standard agent, which cannot chat until its tray is installed. Re-run its installer from a 0.36 or later portal: the tray starts at the next sign-in.',
  };
}

// ── What the technician sees about the far end ───────────────────────────────

export type PresenceCode = 'waiting_for_checkin' | 'connecting' | 'window_open' | 'no_user' | 'window_failed' | 'user_closed' | 'computer_silent' | 'window_closed' | 'ended';

/**
 * One line about where the conversation stands at the computer, from what the
 * agent last said — never inferred from the technician's side. `computer_silent`
 * is the one derived state: the agent picked the chat up and has not polled
 * for over a minute (it holds a poll for 25 s, so a live agent is never that
 * quiet).
 */
export function presence(c: { status: string; deviceState: string | null; deviceSeenAt: Date | null; endedReason?: string | null; startedBy?: string | null }, now: number, via: 'window' | 'tray' = 'window'): { code: PresenceCode; text: string } {
  if (c.status === 'ENDED') {
    const by = c.endedReason === 'end_user'
      ? (via === 'tray' ? 'The person at the computer ended the chat.' : 'The person at the computer closed the chat window.')
      : c.endedReason === 'inactive' ? 'Ended after two hours without activity.' : 'Ended by the technician.';
    return { code: 'ended', text: by };
  }
  if (!c.deviceState || !c.deviceSeenAt) {
    return via === 'tray'
      ? { code: 'waiting_for_checkin', text: 'Waiting for the tray on the computer to open the chat (it learns of a new chat at the next check-in, normally within 3 minutes).' }
      : { code: 'waiting_for_checkin', text: 'Waiting for the computer to pick the chat up at its next check-in (normally within 3 minutes).' };
  }
  // The /assist page (0.36) polls every few seconds while it is open; a page
  // that has stopped is a closed window, which the person can reopen from the
  // tray icon. That is what the page last did, not a guess about the person.
  if (via === 'tray' && now - c.deviceSeenAt.getTime() > 60_000 && c.deviceState === 'window_open') {
    return { code: 'window_closed', text: 'The chat window on the computer is closed. The person can reopen it from the tray icon; new messages show a badge there.' };
  }
  if (now - c.deviceSeenAt.getTime() > 60_000 && c.deviceState !== 'no_user') {
    return { code: 'computer_silent', text: 'The computer has not been in touch for over a minute. It may have gone offline or to sleep.' };
  }
  switch (c.deviceState) {
    case 'connecting': return { code: 'connecting', text: 'The agent is opening the chat window.' };
    case 'window_open': return { code: 'window_open', text: 'The chat window is open on the computer.' };
    case 'no_user': return { code: 'no_user', text: 'Nobody is signed in at the computer\'s console, so there is no desktop to show the chat on. It opens when someone signs in.' };
    case 'window_failed': return { code: 'window_failed', text: 'The agent could not open the chat window on the computer.' };
    default: return { code: 'user_closed', text: 'The person at the computer closed the chat window.' };
  }
}

/** A technician message's delivery, from the times the agent confirmed. */
export function receipt(m: { sender: string; deliveredAt: Date | null; shownAt: Date | null; readAt: Date | null }): 'sent' | 'delivered' | 'shown' | 'read' | null {
  if (m.sender !== 'TECHNICIAN') return null;
  return m.readAt ? 'read' : m.shownAt ? 'shown' : m.deliveredAt ? 'delivered' : 'sent';
}
