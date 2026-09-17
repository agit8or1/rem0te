import * as React from 'react';

import {
  Circle,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Session status, as the console can honestly describe it.
 *
 * Worth knowing before changing a label here: Rem0te's part of a session ends
 * when it hands out the credential. RustDesk carries the connection, and there
 * is no channel that reports back that a session started, or ended, or failed
 * after that point. So `client_opened` is not a step on the way to something —
 * it is where a working session stays until a sweeper closes it out on a
 * timer. Any label implying progress is a label that will be wrong forever.
 */
type SessionStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'pending'
  | 'connecting'
  | 'disconnected'
  | string;

interface StatusConfig {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
  icon: React.ElementType;
  className: string;
}

const SESSION_STATUS_MAP: Record<string, StatusConfig> = {
  active: {
    label: 'Active',
    variant: 'default',
    icon: Circle,
    className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100',
  },
  session_started: {
    label: 'Active',
    variant: 'default',
    icon: Circle,
    className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-100',
  },
  completed: {
    label: 'Completed',
    variant: 'secondary',
    icon: CheckCircle,
    className: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-100',
  },
  session_completed: {
    label: 'Completed',
    variant: 'secondary',
    icon: CheckCircle,
    className: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-100',
  },
  failed: {
    label: 'Failed',
    variant: 'destructive',
    icon: XCircle,
    className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-100',
  },
  canceled: {
    label: 'Canceled',
    variant: 'secondary',
    icon: XCircle,
    className: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200',
  },
  pending: {
    label: 'Connected / Waiting',
    variant: 'outline',
    icon: Circle,
    className: 'bg-green-50 text-green-800 border-green-300 dark:bg-green-950 dark:text-green-200',
  },
  launch_requested: {
    label: 'Connecting…',
    variant: 'outline',
    icon: Clock,
    className: 'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-100',
  },
  launcher_acknowledged: {
    label: 'Connecting…',
    variant: 'outline',
    icon: Clock,
    className: 'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-100',
  },
  // Not "Connecting…". This is the furthest any session ever gets: Rem0te
  // handed out the credential and the client was launched, and nothing after
  // that reports back — RustDesk carries the session and hbbs logs nothing for
  // a connect or a disconnect. Labelling the terminal state as an intermediate
  // one meant every session a technician was sitting in, working, read as
  // still trying to connect, and so did every session from the day before.
  client_opened: {
    label: 'Launched',
    variant: 'outline',
    icon: Circle,
    className: 'bg-green-50 text-green-800 border-green-300 dark:bg-green-950 dark:text-green-200',
  },
  connecting: {
    label: 'Connecting…',
    variant: 'outline',
    icon: Clock,
    className: 'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-100',
  },
  disconnected: {
    label: 'Disconnected',
    variant: 'secondary',
    icon: AlertCircle,
    className: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200',
  },
};

interface SessionStatusBadgeProps {
  status: SessionStatus;
  className?: string;
}

export function SessionStatusBadge({ status, className }: SessionStatusBadgeProps) {
  const normalizedStatus = status.toLowerCase();
  const config = SESSION_STATUS_MAP[normalizedStatus] ?? {
    label: status,
    variant: 'outline' as const,
    icon: Circle,
    className: '',
  };

  const Icon = config.icon;
  const isPulse = normalizedStatus === 'pending';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        config.className,
        className,
      )}
    >
      <Icon className={cn('h-3 w-3', isPulse && 'animate-pulse')} aria-hidden="true" />
      {config.label}
    </span>
  );
}
