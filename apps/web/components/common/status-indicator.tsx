import * as React from 'react';
import { cn } from '@/lib/utils';

type StatusType =
  | 'online'
  | 'offline'
  | 'connecting'
  | 'error'
  | 'active'
  | 'inactive'
  | 'pending'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'in_progress'
  | string;

interface StatusConfig {
  color: string;
  label: string;
}

const STATUS_MAP: Record<string, StatusConfig> = {
  online: { color: 'bg-green-500', label: 'Online' },
  offline: { color: 'bg-gray-400', label: 'Offline' },
  connecting: { color: 'bg-yellow-400 animate-pulse', label: 'Connecting' },
  error: { color: 'bg-red-500', label: 'Error' },
  active: { color: 'bg-green-500', label: 'Active' },
  inactive: { color: 'bg-gray-400', label: 'Inactive' },
  pending: { color: 'bg-yellow-400', label: 'Pending' },
  suspended: { color: 'bg-red-400', label: 'Suspended' },
  completed: { color: 'bg-blue-500', label: 'Completed' },
  failed: { color: 'bg-red-500', label: 'Failed' },
  in_progress: { color: 'bg-blue-400 animate-pulse', label: 'In Progress' },
};

interface StatusIndicatorProps {
  status: StatusType;
  showLabel?: boolean;
  className?: string;
}

export function StatusIndicator({
  status,
  showLabel = true,
  className,
}: StatusIndicatorProps) {
  const normalizedStatus = status.toLowerCase().replace(/\s+/g, '_');
  const config = STATUS_MAP[normalizedStatus] ?? {
    color: 'bg-gray-400',
    label: status,
  };

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        className={cn('inline-block h-2 w-2 rounded-full shrink-0', config.color)}
        aria-hidden="true"
      />
      {showLabel && (
        <span className="text-sm text-muted-foreground">{config.label}</span>
      )}
    </span>
  );
}
