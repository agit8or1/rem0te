import * as React from 'react';
import { cn } from '@/lib/utils';
import { connectivityFrom, connectivityHint, connectivityLabel, CONNECTIVITY_DOT, CONNECTIVITY_TEXT } from '@/lib/connectivity';

/**
 * A computer's connectivity as a dot and a word (0.35): green Online, amber
 * "Reachable (RustDesk) · agent silent …", grey Offline — see
 * lib/connectivity.ts. For lists that once drew `isOnline` as Online/Offline.
 * `short` says "Agent silent" instead of the full label, for tight cells; the
 * tooltip always carries what still works.
 */
export function ConnectivityIndicator({ x, short = false, lowercase = false, className, showDot = true }: {
  x: { connectivity?: unknown; isOnline?: unknown; lastSeenAt?: unknown };
  short?: boolean; lowercase?: boolean; className?: string; showDot?: boolean;
}) {
  const c = connectivityFrom(x);
  let label = short && c === 'agent_silent' ? 'Agent silent' : connectivityLabel(c, x.lastSeenAt);
  if (lowercase) label = label.charAt(0).toLowerCase() + label.slice(1);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)} data-connectivity={c} title={connectivityHint(c)}>
      {showDot && <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', CONNECTIVITY_DOT[c])} aria-hidden="true" />}
      <span className={CONNECTIVITY_TEXT[c]}>{label}</span>
    </span>
  );
}
