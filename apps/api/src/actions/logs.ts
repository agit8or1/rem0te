import { redact } from '../diagnostics-catalog/catalog';
import { LOG_SOURCES, MAX_LOGS_CHARS, MAX_LOG_SECTION_CHARS } from './catalog';

/**
 * What windows.logs.collect (0.32) reported, made fit to store.
 *
 * The agent redacts before anything leaves the computer, but that copy is
 * the agent's, so the portal does it again: the diagnostics catalog's
 * redact() (control characters, user-profile paths, long opaque tokens) and
 * the same key=value credential rule the agent applies. Then one section per
 * known source, in the fixed order, each cut to MAX_LOG_SECTION_CHARS and all
 * of them to MAX_LOGS_CHARS. Plain module: the unit test reads what the API runs.
 */

// Credentials written as key=value or key: value in a log line. The same
// rule as RedactLog in tools/windows-installer/internal/action/maintenance.go.
const CRED = /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*)((?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|\S+)/gi;

/** redact(), keeping newlines (it already keeps tabs), plus the credential rule. */
export function redactLog(s: string): string {
  return s.replace(/\r\n/g, '\n').split('\n').map((l) => redact(l)).join('\n').replace(CRED, '$1$2[redacted]');
}

export interface LogSection { source: (typeof LOG_SOURCES)[number]; text: string; truncated: boolean; note?: string }

export function sanitizeLogs(raw: LogSection[]): LogSection[] {
  const out: LogSection[] = [];
  let total = 0;
  for (const source of LOG_SOURCES) {
    const s = raw.find((x) => x.source === source);
    if (!s) continue;
    let text = redactLog(s.text);
    let truncated = s.truncated;
    if (text.length > MAX_LOG_SECTION_CHARS) { text = text.slice(text.length - MAX_LOG_SECTION_CHARS); truncated = true; }
    if (total + text.length > MAX_LOGS_CHARS) { text = text.slice(text.length - Math.max(0, MAX_LOGS_CHARS - total)); truncated = true; }
    total += text.length;
    out.push({ source, text, truncated, ...(s.note ? { note: redactLog(s.note).slice(0, 300) } : {}) });
  }
  return out;
}
