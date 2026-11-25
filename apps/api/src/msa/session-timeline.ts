/**
 * A managed session's timeline (0.73, build step 5,
 * docs/managed-secure-access.md §3.5). Pure: one function over a grant row.
 *
 *   Requested → Authorized → Received → Applied → Launched → Connected →
 *   Disconnected / Expired / Revoked / Failed
 *
 * Every step is something the portal or the computer's signed agent
 * observed, with its time; a step nobody observed is absent, never assumed.
 * In particular Launched (the one-time password went to the technician's
 * launcher or Connect script) is never shown as Connected: Connected means
 * the agent saw RustDesk's connection manager start while the grant was
 * applied. What the agent cannot see is stated with every timeline.
 */

export const TIMELINE_STEPS = ['requested', 'authorized', 'received', 'applied', 'launched', 'connected', 'disconnected', 'expired', 'revoked', 'failed'] as const;
export type TimelineStep = (typeof TIMELINE_STEPS)[number];

export const STEP_LABEL: Record<TimelineStep, string> = {
  requested: 'Requested', authorized: 'Authorized', received: 'Received by the agent', applied: 'Applied (settings read back)',
  launched: 'Launched', connected: 'Connected', disconnected: 'Disconnected', expired: 'Expired', revoked: 'Revoked', failed: 'Failed',
};

/** What the agent cannot see, said on every session. */
export const CANNOT_SEE = [
  'Who is at the other end: the agent sees that RustDesk accepted a connection, not which person or client made it.',
  'Whether the person at the computer accepted the consent prompt: RustDesk\'s connection manager also appears while its prompt is open.',
  'What happened inside the session.',
] as const;

export interface TimelineRow {
  state: string;
  source: string;
  createdAt: Date;
  receivedAt: Date | null;
  deliveredAt: Date | null;
  appliedAt: Date | null;
  launchedAt: Date | null;
  revealedAt: Date | null;
  connectedAt: Date | null;
  endedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  outcome: string | null;
  notAfter: Date;
  maxMinutes: number;
}

export interface TimelineEntry { step: TimelineStep; label: string; at: string; note?: string }
export interface Timeline {
  /** The latest step, in words. */
  status: string;
  /** requested | authorized | received | applied | launched | connected | disconnected | expired | revoked | failed */
  current: TimelineStep;
  /** True while this grant is, or can still become, an open session. */
  live: boolean;
  steps: TimelineEntry[];
  cannotSee: readonly string[];
}

const END_EXPIRED = new Set(['max_minutes', 'no_connection']);
const iso = (d: Date) => d.toISOString();

export function sessionTimeline(r: TimelineRow, now = Date.now()): Timeline {
  const steps: TimelineEntry[] = [];
  const push = (step: TimelineStep, at: Date | null, note?: string) => { if (at) steps.push({ step, label: STEP_LABEL[step], at: iso(at), ...(note ? { note } : {}) }); };
  push('requested', r.createdAt);
  push('authorized', r.createdAt, r.source === 'connect' ? 'The launch policy allowed it and the grant was signed.' : r.source === 'verify' ? 'A cutover run\'s verification grant.' : 'A Platform Admin\'s test grant.');
  push('received', r.receivedAt ?? (r.appliedAt ? null : r.deliveredAt));
  push('applied', r.appliedAt);
  push('launched', r.launchedAt ?? r.revealedAt, 'The one-time password was handed over. This is not a connection.');
  push('connected', r.connectedAt, 'The agent saw RustDesk\'s connection manager start.');

  let current: TimelineStep = steps[steps.length - 1].step;
  let status: string;
  let live = false;
  const appliedUntil = r.appliedAt ? r.appliedAt.getTime() + r.maxMinutes * 60_000 : 0;
  switch (r.state) {
    case 'issued':
    case 'delivered':
      live = r.notAfter.getTime() >= now;
      status = r.state === 'issued' ? 'Authorized — waiting for the computer\'s agent' : 'Delivered to the computer\'s agent';
      break;
    case 'applied':
      live = appliedUntil > now;
      status = r.connectedAt ? 'Connected (as the agent saw it)' : (r.launchedAt ?? r.revealedAt) ? 'Launched — no connection seen yet' : 'Applied — ready to launch';
      break;
    case 'ended': {
      const step: TimelineStep = r.outcome === 'disconnected' ? 'disconnected' : END_EXPIRED.has(r.outcome ?? '') ? 'expired' : r.outcome === 'revoked' ? 'revoked' : 'disconnected';
      push(step, r.endedAt, r.outcome === 'max_minutes' ? 'The session limit ran out; the agent ended it.' : r.outcome === 'no_connection' ? 'Nobody connected in time; the agent ended it.' : r.outcome ? `Ended on the computer (${r.outcome}).` : undefined);
      current = step;
      status = step === 'expired' ? (r.outcome === 'no_connection' ? 'Expired — nobody connected' : 'Expired — session limit reached') : step === 'revoked' ? 'Revoked — ended on the computer' : 'Disconnected — ended on the computer';
      break;
    }
    case 'revoked':
      push('revoked', r.revokedAt, `Revoked (${r.revokeReason ?? 'revoked'}).`);
      if (r.endedAt) steps.push({ step: 'revoked', label: 'Ended on the device', at: iso(r.endedAt), note: r.outcome ? `The agent ended the session (${r.outcome}).` : 'The agent ended the session.' });
      current = 'revoked';
      status = r.endedAt ? 'Revoked — ended on the computer' : (r.appliedAt ? 'Revoked — waiting for the agent to end it (offline: it ends at the session limit)' : 'Revoked before it was applied');
      break;
    case 'failed':
      push('failed', r.endedAt ?? r.appliedAt ?? r.deliveredAt ?? r.createdAt, r.outcome ? `The agent refused or could not enforce it (${r.outcome}).` : undefined);
      current = 'failed';
      status = `Failed${r.outcome ? ` — ${r.outcome}` : ''}`;
      break;
    case 'expired':
      push('expired', r.notAfter, 'Never delivered to the computer inside its start window.');
      current = 'expired';
      status = 'Expired — never delivered';
      break;
    case 'cancelled':
      current = 'failed';
      status = 'Cancelled — replaced or rolled back before delivery';
      break;
    default:
      status = r.state;
  }
  if (r.state !== 'ended' && r.state !== 'revoked' && r.state !== 'failed' && r.state !== 'expired' && r.state !== 'cancelled') current = steps[steps.length - 1].step;
  return { status, current, live, steps, cannotSee: CANNOT_SEE };
}
