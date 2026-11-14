/**
 * The ticket a "Create ticket" button sends (0.48), as data. Pure: the unit
 * test reads what the API builds. Every connector sends this same draft; a
 * connector only decides how it is carried.
 *
 * Subject: "[Rem0te] <computer> — <log>/<event id> <level>" (or the alert's
 * title), editable by the person before sending, one line, at most 200
 * characters. Body: the computer, business, time, the entry (id, provider,
 * level, message), a link to the computer in the portal, the person's note,
 * and — only if they ticked it and one was asked — the AI explanation, with
 * its provider and model.
 */
import { oneLine } from '../email/mail-content';
import type { ResolvedSource } from '../ai/ai.service';
import { CONTROLS_KEEP_LINES } from '../common/text';

export const SUBJECT_MAX = 200;
export const NOTE_MAX = 4000;
export const MESSAGE_MAX = 8000;

export interface TicketDraft {
  subject: string;
  body: string;
  note: string | null;
  link: string;
  computer: { id: string; name: string };
  business: { id: string | null; name: string | null };
  requestedBy: string;
  sourceRef: string;
  event: { logName: string | null; eventId: number | null; provider: string | null; level: string | null; timeCreated: string | null; message: string } | null;
  alert: { id: string; kind: string; severity: string; title: string; firstSeenAt: string } | null;
  ai: { provider: string; model: string; text: string } | null;
}

/** Free text a person typed: control characters dropped, lines kept, capped. */
export function cleanNote(v: unknown, max = NOTE_MAX): string {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(CONTROLS_KEEP_LINES, '').slice(0, max).trim();
}

const levelOf = (e: NonNullable<ResolvedSource['event']>) => e.levelName ?? (e.level !== null ? `Level ${e.level}` : 'Unknown');

export function defaultSubject(src: Pick<ResolvedSource, 'endpoint' | 'event' | 'alert'>): string {
  if (src.event) return oneLine(`[Rem0te] ${src.endpoint.name} — ${src.event.logName ?? 'Event'}/${src.event.eventId ?? '?'} ${levelOf(src.event)}`, SUBJECT_MAX);
  return oneLine(`[Rem0te] ${src.endpoint.name} — alert: ${src.alert?.title ?? ''} (${(src.alert?.severity ?? '').toLowerCase()})`, SUBJECT_MAX);
}

export function buildDraft(src: ResolvedSource, opts: { subject?: string | null; note?: string | null; link: string; requestedBy: string; ai: TicketDraft['ai'] }): TicketDraft {
  const subject = oneLine(opts.subject && opts.subject.trim() ? opts.subject : defaultSubject(src), SUBJECT_MAX);
  const note = opts.note ? cleanNote(opts.note) || null : null;
  const event = src.event ? {
    logName: src.event.logName, eventId: src.event.eventId, provider: src.event.provider, level: levelOf(src.event),
    timeCreated: src.event.timeCreated, message: cleanNote(src.event.message ?? '', MESSAGE_MAX),
  } : null;
  const alert = src.alert ? { id: src.alert.id, kind: src.alert.kind, severity: src.alert.severity, title: oneLine(src.alert.title, 300), firstSeenAt: src.alert.firstSeenAt } : null;
  const lines = [
    `Computer: ${oneLine(src.endpoint.name, 128)}`,
    `Business: ${oneLine(src.businessName ?? '—', 128)}`,
    `Requested by: ${oneLine(opts.requestedBy, 254)}`,
    `Portal: ${opts.link}`,
    '',
  ];
  if (event) {
    lines.push(`Log: ${event.logName ?? '—'}`, `Event ID: ${event.eventId ?? '—'}`, `Source: ${oneLine(event.provider ?? '—', 200)}`, `Level: ${event.level}`, `Time: ${event.timeCreated ?? '—'}`, '', 'Message:', event.message || '(no message)');
  } else if (alert) {
    lines.push(`Alert: ${alert.title}`, `Kind: ${alert.kind}`, `Severity: ${alert.severity}`, `First seen: ${alert.firstSeenAt}`);
  }
  if (note) lines.push('', 'Note:', note);
  if (opts.ai) lines.push('', `AI explanation (${opts.ai.provider}, ${opts.ai.model}; generated from a redacted copy of this entry, check before acting):`, opts.ai.text);
  return {
    subject, body: lines.join('\n'), note, link: opts.link,
    computer: { id: src.endpoint.id, name: oneLine(src.endpoint.name, 128) }, business: { id: src.endpoint.customerId, name: src.businessName },
    requestedBy: opts.requestedBy, sourceRef: src.sourceRef, event, alert, ai: opts.ai,
  };
}

/** A ticket reference a PSA returned: a short, inert token, or nothing. */
export function cleanRef(v: unknown): string | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v);
  return typeof v === 'string' && /^[A-Za-z0-9#._:/-]{1,64}$/.test(v.trim()) ? v.trim() : null;
}

/** A ticket URL a PSA returned: https only, shown as text. */
export function cleanUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 512) return null;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null; } catch { return null; }
}
