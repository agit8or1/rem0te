'use client';

import { useApplyDensity, useNavigation, useRecordVisits } from '@/lib/navigation';

/** The shell's side effects (0.87): recent items, and the density preference on <html data-density>. Draws nothing. */
export function ShellEffects() {
  const { prefs } = useNavigation();
  useRecordVisits();
  useApplyDensity(prefs.density);
  return null;
}
