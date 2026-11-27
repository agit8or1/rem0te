/**
 * The eight questions every alert answers (0.92, UX P1-6; directive §16).
 *
 *   1. What happened?                         the explanation's own words
 *   2. Which customer and device are affected? the alert's business, site and device
 *   3. When was it observed?                  first seen, last seen, how often
 *   4. How fresh is the evidence?             the agent's last report, by source
 *   5. Why does it matter?                    per kind, then the severity's reading
 *   6. What can the technician safely do?     the recommended action, and that
 *                                             acknowledging and resolving change
 *                                             nothing on the device
 *   7. Is there an existing related ticket?   only when a PSA is configured or a
 *                                             ticket exists (standalone: absent)
 *   8. Was the problem verified as resolved?  measured clear, closed without a
 *                                             measurement, or a person's word
 *
 * Pure, and built on read from what the alert view already has plus the
 * device's last report: nothing is stored and nothing here acts. It must not
 * claim more than the evidence says. Missing or stale telemetry is never
 * healthy: an agent-reported alert whose agent has gone quiet says the
 * evidence is stale, and a monitor clear that happened while the agent was
 * silent is not verified. A person's resolve is never "verified": only a
 * measurement is.
 */

import { HEARTBEAT_STALE_MS } from '../common/connectivity';

export const QUESTION_KEYS = ['what', 'who', 'when', 'fresh', 'why', 'act', 'ticket', 'resolved'] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

export const QUESTION: Record<QuestionKey, string> = {
  what: 'What happened?',
  who: 'Which customer and device are affected?',
  when: 'When was it observed?',
  fresh: 'How fresh is the evidence?',
  why: 'Why does it matter?',
  act: 'What can I safely do?',
  ticket: 'Is there a related ticket?',
  resolved: 'Was it verified as resolved?',
};

/**
 * Where an alert's evidence comes from. `agent`: the device's own reports
 * (heartbeat, monitor report, inventory, update scan). `absence`: the alert is
 * itself the lack of reports. `vendor`: a stored warranty date. `provider`: a
 * backup provider's report.
 */
export type EvidenceSource = 'agent' | 'absence' | 'vendor' | 'provider' | 'unknown';
export const SOURCE_OF: Record<string, EvidenceSource> = {
  CPU_HIGH: 'agent', MEMORY_HIGH: 'agent', DISK_FREE: 'agent', SERVICE_STOPPED: 'agent', EVENT_MATCH: 'agent', REBOOT_PENDING: 'agent',
  DRIVE_FREE: 'agent', UPTIME_LONG: 'agent', UPDATES_MISSING: 'agent', UPDATE_FAILED: 'agent',
  OFFLINE: 'absence', AGENT_SILENT: 'absence', SITE_OUTAGE: 'absence',
  WARRANTY_EXPIRING: 'vendor',
  BACKUP_STALE: 'provider', BACKUP_FAILED: 'provider', DRILL_FAILED: 'provider', RPO_EXCEEDED: 'provider',
};

/** Freshness: `fresh`, `stale` (agent quiet past the heartbeat window), `absence`, `stored` (vendor or provider data), `unknown`. */
export type Freshness = 'fresh' | 'stale' | 'absence' | 'stored' | 'unknown';
/** Verification: `open`, `verified` (measured clear), `unverified` (cleared or closed without a measurement), `person` (a person's word). */
export type Verification = 'open' | 'verified' | 'unverified' | 'person';

export interface Answer { key: QuestionKey; question: string; text: string; status?: Freshness | Verification | 'linked' | 'none' }

export interface TicketRef { ref: string | null; url: string | null; via: 'psa' | 'automatic' | 'clientst0r' }

export interface QuestionInput {
  kind: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  state: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  business: { name: string } | null;
  site: { name: string } | null;
  device: { name: string } | null;
  /** Devices grouped under a site outage. */
  childCount: number;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  occurrences: number;
  suppressed: boolean;
  resolvedAt: Date | string | null;
  resolvedBy: 'person' | 'monitor' | null;
  resolveNote: string | null;
  /** The device's agent's last report (Endpoint.lastSeenAt); null: never, or no device. */
  agentLastSeenAt: Date | string | null;
  explanation: { whatHappened: string; howSerious: string; recommendedAction: string };
  tickets: TicketRef[];
  /** A PSA connector is configured for this business (or globally). */
  psaConfigured: boolean;
  now: number;
}

const WHY: Record<string, string> = {
  OFFLINE: 'Nothing can be checked, patched or reached remotely while the device is offline, and a server that is down usually means people cannot work.',
  AGENT_SILENT: 'Without the agent, monitoring, patching and approved actions stop for this device, and every other alert on it goes stale. Remote control may still work.',
  SITE_OUTAGE: 'A whole site going quiet at once is usually its internet connection or power, which affects everyone there.',
  DISK_FREE: 'A full system disk stops Windows Update and can stop programs and services from writing files.',
  DRIVE_FREE: 'Programs and services that write to a full drive fail, often without a clear message to the user.',
  CPU_HIGH: 'A processor that stays busy makes the device slow for whoever uses it, and can mean a stuck program.',
  MEMORY_HIGH: 'When memory stays nearly full, Windows pages to disk and the device becomes slow or unresponsive.',
  SERVICE_STOPPED: 'Whatever depends on this service stops working while it is not running.',
  REBOOT_PENDING: 'Installed updates are not in effect until the device restarts, so it stays exposed to what they fix.',
  UPTIME_LONG: 'Updates waiting for a restart are not in effect, and long uptimes hide problems a restart would show.',
  UPDATES_MISSING: 'Missing security and critical updates leave known vulnerabilities open on this device.',
  UPDATE_FAILED: 'A failed update leaves the device without the fix it carries, and repeated failures usually point to a deeper Windows Update problem.',
  WARRANTY_EXPIRING: 'Hardware out of warranty is repaired or replaced at your own cost.',
  BACKUP_STALE: 'Data changed since the last backup cannot be recovered if the device fails now.',
  BACKUP_FAILED: 'A failed backup means the newest data may not be recoverable.',
  DRILL_FAILED: 'A restore test that failed means the backups may not restore when they are needed.',
  RPO_EXCEEDED: 'More data than agreed would be lost if the device failed now.',
};

function ago(at: Date | string | null | undefined, now: number): string | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
const ms = (at: Date | string | null | undefined) => (at ? new Date(at).getTime() : NaN);
const iso = (at: Date | string | null | undefined) => (at ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

/** How fresh the evidence is, from where it comes from. Never "fresh" without a recent report from the device. */
export function freshnessOf(i: Pick<QuestionInput, 'kind' | 'lastSeenAt' | 'agentLastSeenAt' | 'now' | 'childCount'>): { status: Freshness; text: string } {
  const src = SOURCE_OF[i.kind] ?? 'unknown';
  const checked = ago(i.lastSeenAt, i.now);
  const agentAge = ms(i.agentLastSeenAt);
  const agent = ago(i.agentLastSeenAt, i.now);
  if (src === 'absence') {
    if (i.kind === 'SITE_OUTAGE') return { status: 'absence', text: `This alert is the lack of reports: it counts the site's devices that stopped reporting (${i.childCount} grouped). The monitor last checked ${checked ?? 'at an unknown time'}.` };
    return { status: 'absence', text: `This alert is the lack of reports: the device was last heard from ${agent ?? 'never'}. The monitor last checked ${checked ?? 'at an unknown time'}.` };
  }
  if (src === 'vendor') return { status: 'stored', text: `From the stored warranty end date, not live telemetry. The monitor last checked it ${checked ?? 'at an unknown time'}.` };
  if (src === 'provider') return { status: 'stored', text: `From the backup provider's latest report, not the device. The monitor last saw the problem ${checked ?? 'at an unknown time'}.` };
  if (src === 'unknown') return { status: 'unknown', text: `Rem0te does not know where this monitor's evidence comes from. It was last seen ${checked ?? 'at an unknown time'}.` };
  if (!Number.isFinite(agentAge)) return { status: 'unknown', text: 'The device\'s agent has not reported, so nothing here is current, and the device is not known to be healthy.' };
  if (i.now - agentAge > HEARTBEAT_STALE_MS) {
    return { status: 'stale', text: `Stale: the device's agent last reported ${agent}. This shows the device as it was then. It cannot clear or get worse here until the agent reports again, and silence is not health.` };
  }
  return { status: 'fresh', text: `Current: the device's agent reported ${agent}, and the monitor last saw the problem ${checked ?? 'at an unknown time'}.` };
}

/** Was it verified as resolved? Only a measurement verifies; a person's resolve and a closed monitor do not. */
export function verificationOf(i: Pick<QuestionInput, 'kind' | 'state' | 'resolvedAt' | 'resolvedBy' | 'resolveNote' | 'agentLastSeenAt'>): { status: Verification; text: string } {
  if (i.state !== 'RESOLVED') {
    return { status: 'open', text: i.kind === 'EVENT_MATCH'
      ? 'No: it is still open. An event alert clears itself after its quiet period with no matching events while the agent reports, or when you resolve it.'
      : 'No: it is still open. It clears itself when the monitor measures normal again, or when you resolve it.' };
  }
  const note = (i.resolveNote ?? '').trim();
  if (i.resolvedBy === 'person') {
    return { status: 'person', text: `Resolved by a person at ${iso(i.resolvedAt)}${note ? `: “${note}”` : ''}. That is their word, not a measurement. If the monitor sees the problem again, it raises a new alert.` };
  }
  if (!note.startsWith('Cleared')) {
    return { status: 'unverified', text: `Closed by Rem0te without a measurement at ${iso(i.resolvedAt)}${note ? `: ${note}` : ''}.` };
  }
  // A clear. For agent evidence, it counts only if the agent was reporting when it cleared.
  if ((SOURCE_OF[i.kind] ?? 'unknown') === 'agent') {
    const agentAt = ms(i.agentLastSeenAt);
    const resolved = ms(i.resolvedAt);
    if (!Number.isFinite(agentAt) || !Number.isFinite(resolved) || agentAt < resolved - HEARTBEAT_STALE_MS) {
      return { status: 'unverified', text: `Cleared at ${iso(i.resolvedAt)} (${note}), but the device's agent had not reported for a while before then, so nothing measured it. Treat it as unverified.` };
    }
  }
  return { status: 'verified', text: `Yes: the monitor measured it clear at ${iso(i.resolvedAt)}. ${note}` };
}

export function answerAlert(i: QuestionInput): Answer[] {
  const out: Answer[] = [];
  const add = (key: QuestionKey, text: string, status?: Answer['status']) => out.push({ key, question: QUESTION[key], text, ...(status ? { status } : {}) });

  add('what', i.explanation.whatHappened);

  const where = [i.business?.name ?? 'No customer', i.site?.name ? `site ${i.site.name}` : null].filter(Boolean).join(', ');
  add('who', i.kind === 'SITE_OUTAGE'
    ? `${where}: ${i.childCount} device${i.childCount === 1 ? '' : 's'} grouped in this outage, listed below.`
    : `${where}: ${i.device?.name ?? 'no device recorded'}.`);

  const n = i.occurrences;
  add('when', `First seen ${iso(i.firstSeenAt)}; last seen ${iso(i.lastSeenAt)}${n > 1 ? `, ${n} times` : ''}.${i.suppressed ? ' Notifications are held by a maintenance window; the alert is still shown and still counted.' : ''}`);

  const f = freshnessOf(i);
  add('fresh', f.text, f.status);

  add('why', `${WHY[i.kind] ?? 'The monitor describes the condition; Rem0te has no general reason on file for this kind.'} ${i.explanation.howSerious}`);

  add('act', `${i.explanation.recommendedAction} Acknowledging and resolving here change nothing on the device, and no ticket is needed to resolve.`);

  if (i.tickets.length) {
    const t = i.tickets.map((x) => `${x.via === 'automatic' ? 'automatic ticket' : x.via === 'clientst0r' ? 'ClientSt0r ticket' : 'ticket'} ${x.ref ?? '(no reference)'}`);
    add('ticket', `Yes: ${t.join(', ')}.`, 'linked');
  } else if (i.psaConfigured) {
    add('ticket', 'No ticket for this alert. You can create one, but resolving does not need one.', 'none');
  }

  const v = verificationOf(i);
  add('resolved', v.text, v.status);
  return out;
}
