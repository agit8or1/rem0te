/**
 * 0.79: how every computer of one signed plan stands, counted. A plan can
 * name up to 25 computers (an update ring, a script run, a software
 * deployment); seen from one computer's Actions tab the job shows that
 * computer's row only, and before 0.79 nothing there said that four of the
 * other computers had failed. Counts only: no names, no results.
 *
 * Pure: no imports. apps/api/scripts/unit-action-rollback.mjs runs it.
 */

export const TALLY_KEYS = ['succeeded', 'failed', 'refused', 'not_executed', 'uncertain', 'waiting', 'canceled'] as const;
export type TallyKey = (typeof TALLY_KEYS)[number];
export type TargetTally = Record<TallyKey, number> & { total: number; partial: boolean };

/** ActionTargetStatus → the tally it counts towards. An unknown status counts as uncertain, never as success. */
const BUCKET: Record<string, TallyKey> = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  REFUSED_BY_ENDPOINT: 'refused',
  NOT_EXECUTED: 'not_executed',
  UNKNOWN: 'uncertain',
  PENDING: 'waiting',
  DISPATCHED: 'waiting',
  CANCELED: 'canceled',
};

export function targetTally(targets: readonly { status: string }[]): TargetTally {
  const t = Object.fromEntries(TALLY_KEYS.map((k) => [k, 0])) as Record<TallyKey, number>;
  for (const x of targets) t[BUCKET[x.status] ?? 'uncertain']++;
  const bad = t.failed + t.refused + t.not_executed + t.uncertain;
  // Partial: some computers did it and some did not. Waiting ones do not
  // make it partial yet; canceled ones were never going to run.
  return { ...t, total: targets.length, partial: t.succeeded > 0 && bad > 0 };
}
