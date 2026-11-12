/**
 * The device page's AI summary (0.34), as data: what leaves rem0te, and how
 * it is redacted on the way out. Pure functions, no I/O — the unit test
 * (scripts/unit-ai-timeline.mjs) reads exactly what the API runs.
 *
 * Until 0.34 the summary was written by calling a model provider directly
 * from rem0te, with a provider key in rem0te's environment, sending the
 * computer's name, hostname, business, site, tags and every note verbatim.
 * Now it is one request to ClientSt0r's inference gateway (task
 * `device_timeline_v1`, PROPOSED in INTEGRATION_COORDINATION.md §5A), and
 * what that request carries is decided here:
 *
 *   - the minimum: platform, OS, agent version, enrolment state, online and
 *     the dates; the newest notes (text and date); the newest remote
 *     sessions (date, state, duration, issue and resolution text);
 *   - never: the computer's name or hostname, the business, site or tags,
 *     addresses, the logged-on user, the RustDesk ID, who wrote a note, who
 *     ran a session, a session's contact name or e-mail;
 *   - every free-text field passes redactForPeer() first.
 */
import { isIP } from 'net';
import { clean, inert } from './analysis';
import { TimelineSummaryOutput } from './contract';

export const TIMELINE_TASK = 'device_timeline_v1' as const;
export const TIMELINE_OUTPUT_SCHEMA = 'timeline-summary.v1' as const;
export const TIMELINE_INSTRUCTIONS_REF = 'rem0te/device-timeline/v1' as const;

/** Newest first, then sent oldest to newest. */
export const MAX_NOTES = 30;
export const MAX_SESSIONS = 20;
export const MAX_NOTE_CHARS = 2000;
export const MAX_SESSION_TEXT_CHARS = 500;
/** All segments together. The oldest notes and sessions are dropped first. */
export const MAX_PAYLOAD_CHARS = 24_000;
export const MAX_SUMMARY_CHARS = 4000;

// ── Redaction ────────────────────────────────────────────────────────────────

export const REDACTION_KINDS = ['secret', 'token', 'email', 'ip_address', 'mac_address', 'rustdesk_id', 'user_path'] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];
export type RedactionCounts = Record<RedactionKind, number>;
export const zeroCounts = (): RedactionCounts => ({ secret: 0, token: 0, email: 0, ip_address: 0, mac_address: 0, rustdesk_id: 0, user_path: 0 });

// Credentials written as key=value / key: value — the same rule as the 0.32
// log redaction (actions/logs.ts) and the agent's RedactLog.
const CRED_KV = /\b(password|passwd|pwd|passcode|secret|token|api[_-]?key|authorization|pin)(["']?\s*[:=]\s*)((?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|\S+)/gi;
// …and as a technician writes them in a note: "password is hunter2".
const CRED_PROSE = /\b(password|passwd|pwd|passcode|pin)(\s+(?:is|was|now|=|set to|changed to)\s+)(\S+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi;
// rem0te public API keys (rk_…) and other prefixed keys people paste.
const PREFIXED_KEY = /\b(?:rk|sk|pk|ghp|gho|xox[abpr])[_-][A-Za-z0-9_-]{8,}/g;
// Bounded (RFC 5321 lengths), so a long run of dots and digits cannot make it
// rescan the rest of the text from every position.
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
// Written out flat: nested quantifiers are what makes a pattern backtrack badly.
const MAC = /\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}\1[0-9A-Fa-f]{2}\1[0-9A-Fa-f]{2}\1[0-9A-Fa-f]{2}\1[0-9A-Fa-f]{2}\b/g;
// IPv6 candidates are bounded runs of hex, colons and dots, checked with
// net.isIP(); a time like 10:30:00 or a C++ "std::string" is not an address
// and is left alone.
const IPV6_CANDIDATE = /(?<![\w:.])[0-9A-Fa-f:.]{2,45}(?![\w:.])/g;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Long opaque strings (keys, hashes, tokens) and hex of 32+ (the capture
// masking policy's rule): a value does not have to be labelled to be one.
const LONG_TOKEN = /\b[A-Za-z0-9+/_-]{40,}={0,2}/g;
const LONG_HEX = /\b[a-f0-9]{32,}\b/gi;
// RustDesk IDs are 9 or 10 digits (the capture masking policy masks 9).
const RUSTDESK_ID = /(?<![\d.])\d{9,10}(?![\d.])/g;
const PROFILE_PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"'<>|]+/gi;

/**
 * Redact one free-text value before it leaves rem0te for ClientSt0r.
 *
 * Stricter than the screenshot masking on addresses: every IPv4 and IPv6
 * address is removed, private ranges included, because the integration's
 * rule (docs/integration-clientst0r.md) is that addresses are never sent to
 * the gateway at all. Counts are per kind and are what the audit records —
 * never the values.
 */
export function redactForPeer(input: string, counts: RedactionCounts = zeroCounts()): { text: string; counts: RedactionCounts } {
  const hit = (k: RedactionKind, to: string) => () => { counts[k]++; return to; };
  let s = clean(input, 100_000);
  s = s.replace(URL_USERINFO, (_m, scheme: string) => { counts.secret++; return `${scheme}[redacted]@`; });
  s = s.replace(CRED_KV, (_m, k: string, sep: string) => { counts.secret++; return `${k}${sep}[redacted]`; });
  s = s.replace(CRED_PROSE, (_m, k: string, sep: string) => { counts.secret++; return `${k}${sep}[redacted]`; });
  s = s.replace(BEARER, (_m, scheme: string) => { counts.secret++; return `${scheme} [redacted]`; });
  s = s.replace(PREFIXED_KEY, hit('token', '[token]'));
  s = s.replace(EMAIL, hit('email', '[email]'));
  s = s.replace(MAC, hit('mac_address', '[mac]'));
  s = s.replace(IPV6_CANDIDATE, (m) => {
    if (m.indexOf(':') === m.lastIndexOf(':')) return m; // fewer than two colons
    const dot = m.endsWith('.') ? '.' : ''; // the full stop ending a sentence
    if (isIP(dot ? m.slice(0, -1) : m) === 6) { counts.ip_address++; return `[ip]${dot}`; }
    return m;
  });
  s = s.replace(IPV4, (m) => (isIP(m) === 4 ? (counts.ip_address++, '[ip]') : m));
  s = s.replace(LONG_HEX, hit('token', '[token]'));
  s = s.replace(LONG_TOKEN, hit('token', '[token]'));
  s = s.replace(RUSTDESK_ID, hit('rustdesk_id', '[id]'));
  s = s.replace(PROFILE_PATH, hit('user_path', '%USERPROFILE%'));
  return { text: s, counts };
}

// ── What is sent ─────────────────────────────────────────────────────────────

export interface TimelineSnapshot {
  id: string;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  status: string;
  isOnline: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  notes: { createdAt: Date; content: string; isPinned: boolean }[];
  sessions: { createdAt: Date; status: string; issueDescription: string | null; disposition: string | null; duration: number | null }[];
}

export type TimelineSegmentKind = 'device_facts' | 'device_note' | 'support_session';
export interface TimelineSegment { ref: string; kind: TimelineSegmentKind; author_role: 'staff' | 'rem0te'; text: string }

/**
 * Every field that leaves rem0te, in the order the console shows them. The
 * console renders this list; the unit test asserts the payload never carries
 * a field outside it.
 */
export const TIMELINE_FIELDS: { field: string; from: string; redacted: boolean }[] = [
  { field: 'rem0te_endpoint_id', from: "The computer's rem0te id (opaque; not its name)", redacted: false },
  { field: 'platform, os', from: 'Platform and OS version, reduced to a plain character set', redacted: false },
  { field: 'agent_version', from: 'Agent version', redacted: false },
  { field: 'enrolment_status, online, last_seen, enrolled', from: 'Enrolment state, online flag and two dates', redacted: false },
  { field: 'note', from: `Up to ${MAX_NOTES} newest notes: date, pinned, text (each cut to ${MAX_NOTE_CHARS} characters)`, redacted: true },
  { field: 'support_session', from: `Up to ${MAX_SESSIONS} newest remote sessions: date, state, minutes, issue and resolution text`, redacted: true },
  { field: 'redactions', from: 'How many values of each kind were removed (counts, not values)', redacted: false },
];

/** What is deliberately never sent. Shown beside the list above. */
export const TIMELINE_NOT_SENT = [
  "The computer's name and hostname", 'The business, site and tags', 'IP and MAC addresses', 'The logged-on user and the domain',
  'The RustDesk ID and any password', 'Who wrote a note or ran a session', "A session's contact name and e-mail", 'Session telemetry and events',
];

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Build the segments for one computer. Notes and sessions are taken newest
 * first (the cap keeps the recent ones, not the oldest), then put in date
 * order. Each text is clipped to four times its cap before redaction (so a
 * huge note cannot make redaction expensive) and to its cap after. If the
 * total is over MAX_PAYLOAD_CHARS, the oldest notes and
 * sessions are dropped until it fits; the facts segment always stays.
 */
export function buildTimelinePayload(snap: TimelineSnapshot): {
  segments: TimelineSegment[]; redactions: RedactionCounts; chars: number; dropped: number;
  counts: { notes: number; sessions: number };
} {
  const counts = zeroCounts();
  const facts: TimelineSegment = {
    ref: 'device:facts', kind: 'device_facts', author_role: 'rem0te',
    text: [
      `platform=${inert(snap.platform, 32) || 'unknown'}`,
      `os=${inert(snap.osVersion) || 'unknown'}`,
      `agent_version=${inert(snap.agentVersion, 32) || 'unknown'}`,
      `enrolment_status=${inert(snap.status, 32)}`,
      `online=${snap.isOnline}`,
      `last_seen=${snap.lastSeenAt ? snap.lastSeenAt.toISOString() : 'never'}`,
      `enrolled=${day(snap.createdAt)}`,
    ].join('\n'),
  };
  type Dated = { at: Date; seg: TimelineSegment };
  const notes: Dated[] = [...snap.notes]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, MAX_NOTES)
    .map((n) => ({
      at: n.createdAt,
      seg: { ref: '', kind: 'device_note' as const, author_role: 'staff' as const,
        text: `date=${day(n.createdAt)}${n.isPinned ? ' pinned=true' : ''}\n${redactForPeer(n.content.slice(0, MAX_NOTE_CHARS * 4), counts).text.slice(0, MAX_NOTE_CHARS)}` },
    }));
  const sessions: Dated[] = [...snap.sessions]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, MAX_SESSIONS)
    .map((s) => {
      const lines = [`date=${day(s.createdAt)} state=${inert(s.status, 32)}${s.duration ? ` minutes=${Math.round(s.duration / 60)}` : ''}`];
      if (s.issueDescription) lines.push(`issue: ${redactForPeer(s.issueDescription.slice(0, MAX_SESSION_TEXT_CHARS * 4), counts).text.slice(0, MAX_SESSION_TEXT_CHARS)}`);
      if (s.disposition) lines.push(`resolution: ${redactForPeer(s.disposition.slice(0, MAX_SESSION_TEXT_CHARS * 4), counts).text.slice(0, MAX_SESSION_TEXT_CHARS)}`);
      return { at: s.createdAt, seg: { ref: '', kind: 'support_session' as const, author_role: 'staff' as const, text: lines.join('\n') } };
    });
  const dated = [...notes, ...sessions].sort((a, b) => a.at.getTime() - b.at.getTime());
  let total = facts.text.length + dated.reduce((n, d) => n + d.seg.text.length, 0);
  let dropped = 0;
  while (total > MAX_PAYLOAD_CHARS && dated.length > 0) { total -= dated.shift()!.seg.text.length; dropped++; }
  let ni = 0, si = 0;
  for (const d of dated) d.seg.ref = d.seg.kind === 'device_note' ? `note:${++ni}` : `session:${++si}`;
  return { segments: [facts, ...dated.map((d) => d.seg)], redactions: counts, chars: total, dropped, counts: { notes: ni, sessions: si } };
}

// ── What comes back ──────────────────────────────────────────────────────────

/** Parse the model's output. Never throws. Unknown fields are dropped and counted; the text is cleaned. */
export function parseTimelineOutput(raw: unknown): { summary: string | null; dropped: number } {
  const r = TimelineSummaryOutput.safeParse(raw);
  if (!r.success) return { summary: null, dropped: 0 };
  const summary = clean(r.data.summary, MAX_SUMMARY_CHARS).trim();
  const dropped = raw && typeof raw === 'object' ? Object.keys(raw).filter((k) => k !== 'summary').length : 0;
  return { summary: summary || null, dropped };
}
