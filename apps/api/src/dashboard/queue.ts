/**
 * The dashboard's "work on next" queue (0.31) — pure, so the ranking can be
 * read and tested without Nest or Prisma.
 *
 * Every item carries the reason it is on the list. The order is a fixed
 * ladder of kinds (below), then oldest first within a kind: the queue never
 * invents an urgency score from things it cannot see (a customer's contract,
 * a VIP), and a technician who disagrees with the order can see exactly why
 * an item sits where it does.
 *
 * What is deliberately NOT in the queue:
 *   - acknowledged alerts: someone already has them (they are under "Being
 *     worked on");
 *   - alerts in a maintenance window: silenced on purpose;
 *   - offline alerts grouped under a site outage: the outage is the item.
 */

export type QueueKind =
  | 'site_outage'
  | 'alert'
  | 'action_uncertain'
  | 'action_failed'
  | 'rollout_failed'
  | 'approval_waiting'
  | 'restart_pending';

export type QueueSeverity = 'critical' | 'warning' | 'info';

export interface QueueItem {
  key: string;
  kind: QueueKind;
  severity: QueueSeverity;
  title: string;
  /** Plain words: why this is on the list, and why at this position. */
  reason: string;
  business: { id: string; name: string } | null;
  device: { id: string; name: string } | null;
  /** When the problem started (or the request was made). */
  since: string;
  href: string;
}

/**
 * The ladder. Higher first. A critical alert outranks an uncertain action
 * because the alert is a live problem; an uncertain action outranks a warning
 * because it blocks any new request for that action on that computer until a
 * person records what they found.
 */
export const RANK: Record<string, number> = {
  site_outage: 100,
  'alert:critical': 90,
  action_uncertain: 80,
  action_failed: 70,
  'alert:warning': 60,
  rollout_failed: 50,
  approval_waiting: 40,
  restart_pending: 30,
  'alert:info': 20,
};

export function rankOf(i: Pick<QueueItem, 'kind' | 'severity'>): number {
  return RANK[i.kind === 'alert' ? `alert:${i.severity}` : i.kind] ?? 0;
}

export function rankQueue(items: QueueItem[], limit = 12): { items: (QueueItem & { rank: number })[]; total: number } {
  const ranked = items
    .map((i) => ({ ...i, rank: rankOf(i) }))
    .sort((a, b) => b.rank - a.rank || Date.parse(a.since) - Date.parse(b.since) || a.key.localeCompare(b.key));
  return { items: ranked.slice(0, limit), total: ranked.length };
}

/** "3 h", "2 d", "12 min" — the age a reason quotes. */
export function age(since: Date | string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(since).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
