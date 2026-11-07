import * as React from 'react';

import {
  Circle,
  CheckCircle,
  XCircle,
  Clock,
  HelpCircle,
  MonitorPlay,
  Ban,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Session status, using the same words as the API (STATUS_LABEL in
 * apps/api/src/sessions/session-state.ts).
 *
 * Each state is tied to the one signal that can move a session into it, so a
 * label must never claim more than that signal shows:
 *   - "Launch requested" / "Launcher acknowledged": a credential was handed
 *     out, nothing has opened a client yet.
 *   - "Client opened": RustDesk started on the technician's computer. That is
 *     not a connection.
 *   - "Connection confirmed": the endpoint agent saw a connection, or the
 *     technician said so.
 *   - "Status unknown": closed by a timeout with no confirming or failing
 *     signal. It may well have connected; nothing says either way.
 */
export const SESSION_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Recorded',
  LAUNCH_REQUESTED: 'Launch requested',
  LAUNCHER_ACKNOWLEDGED: 'Launcher acknowledged',
  CLIENT_OPENED: 'Client opened',
  SESSION_STARTED: 'Connection confirmed',
  SESSION_COMPLETED: 'Disconnected',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
  STATUS_UNKNOWN: 'Status unknown',
};

/** Closed states. Mirrors TERMINAL in session-state.ts. */
export const TERMINAL_SESSION_STATUSES = ['SESSION_COMPLETED', 'FAILED', 'CANCELED', 'STATUS_UNKNOWN'];

export function isTerminalSessionStatus(status: string | null | undefined) {
  return !!status && TERMINAL_SESSION_STATUSES.includes(status.toUpperCase());
}

interface StatusConfig {
  icon: React.ElementType;
  className: string;
}

const NEUTRAL = 'bg-muted text-muted-foreground border-border';
const PRE_CLIENT = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900';

const STYLE: Record<string, StatusConfig> = {
  PENDING: { icon: Clock, className: NEUTRAL },
  LAUNCH_REQUESTED: { icon: Clock, className: PRE_CLIENT },
  LAUNCHER_ACKNOWLEDGED: { icon: Clock, className: PRE_CLIENT },
  CLIENT_OPENED: {
    icon: MonitorPlay,
    className: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-900',
  },
  SESSION_STARTED: {
    icon: Circle,
    className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100 dark:border-green-800',
  },
  SESSION_COMPLETED: {
    icon: CheckCircle,
    className: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-100 dark:border-blue-800',
  },
  FAILED: {
    icon: XCircle,
    className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-100 dark:border-red-800',
  },
  CANCELED: { icon: Ban, className: NEUTRAL },
  STATUS_UNKNOWN: {
    icon: HelpCircle,
    className: 'bg-zinc-100 text-zinc-700 border-zinc-300 border-dashed dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700',
  },
};

interface SessionStatusBadgeProps {
  status: string;
  className?: string;
}

export function SessionStatusBadge({ status, className }: SessionStatusBadgeProps) {
  const key = (status ?? '').toUpperCase();
  const label = SESSION_STATUS_LABEL[key] ?? status;
  const config = STYLE[key] ?? { icon: Circle, className: NEUTRAL };
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        config.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
