'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { routineConfirmApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

/**
 * 0.46.1: whether everyday changes (installing or removing software, catalog
 * edits, service and process actions, patch installs, agent upgrades and
 * automatic agent updates) ask "confirm it is you" on top of the signed-in
 * session. Off by default. Security settings always ask, whatever this says.
 * Turning it off asks once; turning it on never does.
 */
type View = { value: 'off' | 'every'; canChange: boolean };

function apiError(e: unknown) {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof m === 'string' ? m : 'The setting was not saved.';
}

export function RoutineConfirmCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isError } = useQuery<View>({
    queryKey: ['routine-confirm'],
    queryFn: () => routineConfirmApi.get().then((r) => r.data?.data),
    retry: false,
  });
  const set = useMutation({
    mutationFn: (v: 'off' | 'every') => routineConfirmApi.set(v),
    onSuccess: (r) => { qc.setQueryData(['routine-confirm'], r.data?.data); toast({ title: 'Saved' }); },
    onError: (e) => toast({ title: 'Not saved', description: apiError(e), variant: 'destructive' }),
  });
  if (isError || !data) return null;
  return (
    <Card data-testid="routine-confirm-card">
      <CardHeader><CardTitle className="text-sm">Confirm before everyday changes</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Installing or uninstalling software, editing a software catalog, starting or stopping services, ending processes,
          installing updates, upgrading an agent and changing automatic agent updates. <strong>Off</strong>: signing in is enough.{' '}
          <strong>Every 10 minutes</strong>: asks you to confirm it is you, and the confirmation lasts 10 minutes. Security
          settings, passwords, permissions, API keys, passkeys and containment always ask. Every change is in the audit log either way.
        </p>
        <div className="flex flex-wrap items-center gap-2" data-testid="routine-confirm" data-value={data.value}>
          <Button size="sm" variant={data.value === 'off' ? 'default' : 'outline'} disabled={!data.canChange || set.isPending} onClick={() => set.mutate('off')}>Off</Button>
          <Button size="sm" variant={data.value === 'every' ? 'default' : 'outline'} disabled={!data.canChange || set.isPending} onClick={() => set.mutate('every')}>Every 10 minutes</Button>
          {!data.canChange && <span className="text-xs text-muted-foreground">A Platform Admin changes this.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
