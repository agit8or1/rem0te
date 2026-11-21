/**
 * 0.79: words for a job's per-computer tally (actions/target-tally.ts on the
 * API), so a plan that went to several computers says plainly when some of
 * them failed. Pure: no imports; apps/api/scripts/unit-action-rollback.mjs
 * transpiles and runs it.
 */

export interface TargetTally {
  succeeded: number; failed: number; refused: number; not_executed: number; uncertain: number; waiting: number; canceled: number;
  total: number; partial: boolean;
}

const WORDS: [keyof Omit<TargetTally, 'total' | 'partial'>, string][] = [
  ['succeeded', 'succeeded'],
  ['failed', 'failed'],
  ['refused', 'refused by the computer'],
  ['not_executed', 'not executed'],
  ['uncertain', 'uncertain'],
  ['waiting', 'still waiting'],
  ['canceled', 'canceled'],
];

/** "Of 5 computers: 3 succeeded, 1 failed, 1 still waiting." Zero counts are left out. */
export function tallyText(t: TargetTally): string {
  const parts = WORDS.filter(([k]) => t[k] > 0).map(([k, w]) => `${t[k]} ${w}`);
  return `Of ${t.total} computer${t.total === 1 ? '' : 's'}: ${parts.length ? parts.join(', ') : 'none counted'}.`;
}

/** Some computers did it and some did not (failed, refused, not executed or uncertain). */
export const tallyProblems = (t: TargetTally) => t.failed + t.refused + t.not_executed + t.uncertain;
