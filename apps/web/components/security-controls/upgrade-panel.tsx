'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { securityControlsApi } from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { apiError, Chip, CHIP, personName, usePeople } from './shared';

interface UpgradeRow {
  assignmentId: string;
  business: string;
  userId: string | null;
  groupId: string | null;
  current: string;
  capabilities: string[];
  holdsLaunchOrCredential: boolean;
  underPreset: { tier: string; gains: string[]; loses: string[] }[];
}

export function UpgradePanel() {
  const { data: people = [] } = usePeople();
  const names = useMemo(() => new Map(people.map((p) => [p.id, personName(p)])), [people]);
  const { data = [], isLoading, isError, error } = useQuery<UpgradeRow[]>({
    queryKey: ['security-controls', 'upgrade-preview'],
    queryFn: () => securityControlsApi.upgradePreview().then((r) => r.data?.data ?? []),
    retry: false,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError) return <p className="text-sm text-destructive">{apiError(error, 'Could not load the upgrade preview').message}</p>;

  const flagged = data.filter((r) => r.holdsLaunchOrCredential).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        What presets would mean for every active assignment. Nothing is changed: an assignment made before presets stays
        custom, with exactly the permissions it has, until someone re-creates it from a preset. Use this to decide which to move.
      </p>
      {flagged > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {flagged} assignment{flagged === 1 ? ' holds' : 's hold'} Remote connect or credential access. No preset reproduces either:
          moving {flagged === 1 ? 'it' : 'them'} to a preset removes standing launch and password access.
        </div>
      )}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          {data.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No active assignments.</p> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Business</th>
                  <th className="px-4 py-2 font-medium">Who</th>
                  <th className="px-4 py-2 font-medium">Now</th>
                  <th className="px-4 py-2 font-medium">Permissions today</th>
                  <th className="px-4 py-2 font-medium">Under each preset</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.assignmentId} className={cn('border-b align-top last:border-0', r.holdsLaunchOrCredential && 'bg-amber-50/70 dark:bg-amber-950/30')}>
                    <td className="px-4 py-2">{r.business}</td>
                    <td className="px-4 py-2">
                      {r.userId ? (names.get(r.userId) ?? <span className="font-mono text-xs">{r.userId}</span>) : r.groupId ? <span>Group <span className="font-mono text-xs">{r.groupId}</span></span> : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <div>{r.current}</div>
                      {r.holdsLaunchOrCredential && <Chip className={cn(CHIP.warn, 'mt-1')}>Connect / credential</Chip>}
                    </td>
                    <td className="max-w-[16rem] px-4 py-2 text-xs text-muted-foreground">{r.capabilities.join(', ') || 'none'}</td>
                    <td className="px-4 py-2 text-xs">
                      <div className="space-y-1">
                        {r.underPreset.map((u) => (
                          <div key={u.tier}>
                            <span className="font-medium">{u.tier}:</span>{' '}
                            {u.gains.length === 0 && u.loses.length === 0 ? <span className="text-muted-foreground">no change</span> : (
                              <>
                                {u.gains.length > 0 && <span className="text-green-700 dark:text-green-400">+{u.gains.join(', +')}</span>}
                                {u.gains.length > 0 && u.loses.length > 0 && ' '}
                                {u.loses.length > 0 && <span className="text-red-700 dark:text-red-400">−{u.loses.join(', −')}</span>}
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
