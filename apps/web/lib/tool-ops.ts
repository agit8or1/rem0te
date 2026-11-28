/**
 * Background technician tools, presented (0.93, UX P1-7; directive §13).
 *
 * Pure: no imports, no fetch, no clock (callers pass `now`). It only words
 * what the server already decided and already returned: a deadline the API
 * sent, a reference to the record's own audit rows, an error code turned into
 * plain words with what to do, and a filter over rows already on screen.
 * Nothing here can start, widen or extend an operation, and nothing decides
 * who may run one; the server stays the authority (§87, §88, §20, §61).
 */

/** The audit log, opened on one record's own rows. The API applies the filter inside the caller's scope. */
export function auditHref(r: { resource: string; resourceId?: string | null; action?: string | null }): string {
  const q = new URLSearchParams({ resource: r.resource });
  if (r.resourceId) q.set('resourceId', r.resourceId);
  if (r.action) q.set('action', r.action);
  return `/audit?${q.toString()}`;
}

/** The record each tool writes its audit rows under (the services' own `resource` / `resourceId`). */
export const AUDIT_RESOURCE = {
  terminal: 'terminal_session',
  file: 'file_transfer',
  /** Event-log and diagnostics rows are keyed by the device, with the command in their metadata. */
  device: 'endpoint',
  action: 'action_job',
} as const;

const two = (n: number) => String(n).padStart(2, '0');

/** "in 12 min" / "in 1 h 05 min" / "now" from milliseconds left (never negative). */
export function leftText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${two(m % 60)} min`;
}

/**
 * A deadline the server sent, in words: "ends at 14:05 (in 12 min)", or
 * "ended at 14:05" once it has passed. Null when there is no usable date:
 * nothing is invented.
 */
export function deadlineText(at: string | Date | null | undefined, now: number, verb: { future: string; past: string } = { future: 'ends', past: 'ended' }): string | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return t > now ? `${verb.future} at ${clock} (${leftText(t - now)})` : `${verb.past} at ${clock}`;
}

/** The short form of a reference id shown on screen; the full id is always copyable. */
export const shortRef = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export interface ToolError { words: string; fix: string | null; code: string | null }

/**
 * What to do about an error the tools' routes answer with. The server's own
 * message is always kept as the words: it is a sentence and carries the
 * specifics (a limit, a version, a path). This only adds the next step where
 * the message does not already say it. Every key is a code the API really
 * returns (unit-tool-ops.mjs checks each one against apps/api/src).
 */
export const TOOL_FIXES: Record<string, string> = {
  // Shared refusals (§70, §16, §62).
  ENDPOINT_UNASSIGNED: 'Adopt the device into a customer first (Devices → Unassigned).',
  CONTAINED: 'See the containment banner at the top of the device page; a Platform Admin can lift the pause.',
  STEP_UP_REQUIRED: 'Confirm it is you when asked, then try again.',
  // Terminal (§87).
  TERMINAL_SIGNED_AGENT_REQUIRED: 'Move the device to the signed agent from its Agent card (Overview).',
  TERMINAL_AGENT_TOO_OLD: 'Update the agent from its Agent card (Overview), then try again.',
  TERMINAL_TOO_MANY: 'Wait for one of the open terminals on this device to end.',
  TERMINAL_ALREADY_OPEN: 'Use the terminal you already have open, or end it.',
  TERMINAL_ENDED: 'Open a new terminal if you still need one.',
  // File transfer (§88).
  FILES_SIGNED_AGENT_REQUIRED: 'Move the device to the signed agent from its Agent card (Overview).',
  FILES_AGENT_TOO_OLD: 'Update the agent from its Agent card (Overview), then try again.',
  FILES_TOO_MANY: 'Wait for a transfer on this device to finish, or cancel one.',
  FILES_TOO_LARGE: 'A Platform Admin can raise the customer\'s file size limit in its remote-operations settings.',
  FILES_PATH_REFUSED: 'Use a full path on a local drive, such as C:\\Temp\\report.txt: no network path, no .., no trailing dot or space.',
  FILES_ENDED: 'Start a new transfer if you still need one.',
  // Requests on the device (§20, §61).
  DIAGNOSTIC_NEEDS_NEWER_AGENT: 'Update the agent; a signed agent gets new checks at the next release.',
  DIAGNOSTIC_RATE_LIMITED: 'Wait a minute before asking again.',
  ACTION_NOT_DIRECT: 'Use a patch policy (Patching → Policies) instead.',
  APPROVAL_SIGNER_REFUSED: 'Read the signer\'s reason on the approval page; nothing ran.',
};

/** Plain words for an error the API answered with: its own message, and the next step when one is known. */
export function toolError(e: { code?: string | null; message?: string | null } | null | undefined): ToolError {
  const code = e?.code ?? null;
  const msg = (e?.message ?? '').trim();
  return { words: msg || 'Something went wrong, and the server did not say what.', fix: (code && TOOL_FIXES[code]) || null, code };
}

/** A device-reported reason code ("process_changed") as words, without inventing a meaning. */
export const reasonWords = (code: string) => code.replace(/_/g, ' ');

/** Case-insensitive filter over rows already on screen. An empty query keeps everything. */
export function filterRows<T>(rows: readonly T[], q: string, text: (r: T) => string): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...rows];
  return rows.filter((r) => text(r).toLowerCase().includes(s));
}

/** Lines of output that contain the query, with their line numbers (1-based), capped. */
export function findLines(output: string, q: string, cap = 200): { n: number; line: string }[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const out: { n: number; line: string }[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < cap; i++) if (lines[i].toLowerCase().includes(s)) out.push({ n: i + 1, line: lines[i] });
  return out;
}
