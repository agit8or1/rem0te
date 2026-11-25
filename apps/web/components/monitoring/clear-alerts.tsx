'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { apiError } from '@/components/security-controls/shared';
import { useToast } from '@/hooks/use-toast';
import { monitoringApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * 0.70: "Clear" a computer's alerts. Resolves every open alert on it (the
 * same resolve as one alert's, audited per alert). The monitors are left as
 * they are, so anything still wrong is raised again at the next check.
 */
export function ClearAlertsButton({ endpointId, name, count, className }: { endpointId: string; name: string; count: number; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const clear = useMutation({
    mutationFn: () => monitoringApi.clearComputer(endpointId).then((r) => r.data.data as { cleared: number; more: boolean }),
    onSuccess: (d) => {
      setOpen(false);
      toast({ title: d.cleared ? `Cleared ${d.cleared} alert${d.cleared === 1 ? '' : 's'}` : 'Nothing to clear', description: d.more ? 'There were more; clear again for the rest.' : 'Anything still wrong comes back at the next check.' });
      for (const key of [['device-list'], ['mon-endpoint', endpointId], ['endpoint', endpointId], ['monitoring']]) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast({ title: 'Could not clear alerts', description: apiError(e).message, variant: 'destructive' }),
  });
  if (count <= 0) return null;
  return (
    <>
      <button type="button" data-testid="clear-alerts"
        className={cn('text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm', className)}
        title="Resolve this device's open alerts until the next check" aria-label={`Clear ${count} open alert${count === 1 ? '' : 's'} on ${name}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
        Clear
      </button>
      {open && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o && !clear.isPending) setOpen(false); }}
          title={`Clear ${count} alert${count === 1 ? '' : 's'} on ${name}?`}
          description="They are resolved now and Health shows Healthy. Monitors are not changed: anything still wrong is raised again at the device's next check, and notifications and tickets work as for a new alert."
          confirmLabel="Clear alerts" loading={clear.isPending} onConfirm={() => clear.mutate()} />
      )}
    </>
  );
}
