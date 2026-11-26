'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn, formatDate } from '@/lib/utils';
import { freshnessText, relativeAge, type Freshness } from '@/lib/device-freshness';

/**
 * One line saying how old a tab's data is (0.88, UX P1-2). The rule is
 * lib/device-freshness.ts; this only draws it. The age re-renders each
 * minute so a page left open does not keep saying "just now".
 */
export function FreshnessLine({ value, className }: { value: Freshness; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const stale = value.verdict === 'stale';
  const unknown = value.verdict === 'unknown';
  return (
    <p
      className={cn('flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}
      data-testid="freshness" data-verdict={value.verdict} data-at={value.at ?? ''}
      title={value.at ? formatDate(value.at) : undefined}
      aria-label={freshnessText(value, now)}
    >
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{value.label}</span>
      <span className={cn('font-medium', unknown ? 'text-foreground' : 'text-foreground/90')}>
        {value.at ? relativeAge(value.at, now) : 'not reported yet'}
      </span>
      {stale && (
        <span className="rounded border border-amber-300 bg-amber-50 px-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">stale</span>
      )}
    </p>
  );
}
