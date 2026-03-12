import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Circle,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
  completed: {
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
  pending: {
    label: 'Pending',
    variant: 'outline',
    icon: Clock,
    className: 'bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-100',
  },
  connecting: {
    label: 'Connecting',
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

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        config.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {config.label}
    </span>
  );
}
