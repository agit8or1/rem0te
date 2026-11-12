'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Camera } from 'lucide-react';
import { snapshotScheduleApi, type SnapshotSchedule, type SnapshotScheduleKey } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type ApiError = { response?: { data?: { message?: string } } };
const errMsg = (e: unknown) => (e as ApiError)?.response?.data?.message ?? 'Something went wrong';

const KEYS: { key: SnapshotScheduleKey; label: string; size: string }[] = [
  { key: 'process_list', label: 'Processes', size: 'about 35 KB a snapshot' },
  { key: 'service_list', label: 'Services', size: 'about 40 KB a snapshot' },
  { key: 'network_adapters', label: 'Network adapters', size: 'about 2 KB a snapshot' },
];
// The choices are the API's bounds (0, or 60–10080 minutes; watched 0 or 3–60).
const INTERVALS = [0, 60, 120, 180, 360, 720, 1440, 10080];
const WATCH = [0, 3, 5, 10, 15, 30, 60];
const label = (m: number) => (m === 0 ? 'Off' : m < 60 ? `${m} minutes` : m === 60 ? 'Every hour' : m === 1440 ? 'Every day' : m === 10080 ? 'Every week' : `Every ${m / 60} hours`);

/**
 * Settings → Monitoring & API → Automatic snapshots (0.35). How often the
 * server asks checking-in Windows computers for their Processes, Services
 * and Network snapshots. Platform Admin only; every change is audited
 * (SNAPSHOT_SCHEDULE_CHANGED).
 */
export function SnapshotScheduleCard() {
  const { isPlatformAdmin, technician } = usePermissions();
  const show = isPlatformAdmin && !technician;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['snapshot-schedule'],
    queryFn: () => snapshotScheduleApi.get().then((r) => r.data.data),
    enabled: show,
    retry: false,
  });
  const [draft, setDraft] = useState<SnapshotSchedule | null>(null);
  useEffect(() => { if (data) setDraft(data); }, [data]);

  const save = useMutation({
    mutationFn: (d: SnapshotSchedule) => snapshotScheduleApi.set({ enabled: d.enabled, minutes: d.minutes, watchMinutes: d.watchMinutes }).then((r) => r.data.data),
    onSuccess: (d) => { qc.setQueryData(['snapshot-schedule'], d); toast({ title: 'Automatic snapshots saved', description: 'Computers pick the new schedule up on their next check-in.' }); },
    onError: (e) => toast({ title: 'Not saved', description: errMsg(e), variant: 'destructive' }),
  });

  if (!show) return null;
  const dirty = !!data && !!draft && JSON.stringify({ e: data.enabled, m: data.minutes, w: data.watchMinutes }) !== JSON.stringify({ e: draft.enabled, m: draft.minutes, w: draft.watchMinutes });

  return (
    <Card data-testid="snapshot-schedule-card">
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Camera className="h-4 w-4" />Automatic snapshots</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="max-w-2xl text-muted-foreground">
          How often the server asks Windows computers (agent 0.33 or later, checking in) for the snapshots on their Processes,
          Services and Network tabs, without anyone pressing Refresh. They are read-only and are asked for on the computer’s
          own check-in, so a computer that is not checking in is not asked. Refresh on each tab still asks at once.
        </p>
        {isLoading && <p className="text-muted-foreground">Loading…</p>}
        {isError && <p className="text-red-600">Could not read the schedule.</p>}
        {data && !data.processEnabled && (
          <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            This server runs with SNAPSHOT_SWEEP=off, so nothing is asked for automatically whatever is saved here.</p>
        )}
        {draft && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} data-testid="snapshot-schedule-enabled" />
              Ask for snapshots automatically
            </label>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {KEYS.map((k) => (
                <div key={k.key} className="space-y-1">
                  <Label htmlFor={`snap-${k.key}`}>{k.label}</Label>
                  <select id={`snap-${k.key}`} className="h-9 w-full rounded-md border bg-background px-2" disabled={!draft.enabled}
                    value={draft.minutes[k.key]} onChange={(e) => setDraft({ ...draft, minutes: { ...draft.minutes, [k.key]: Number(e.target.value) } })}>
                    {[...new Set([...INTERVALS, draft.minutes[k.key]])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{label(m)}</option>)}
                  </select>
                  <p className="text-[11px] text-muted-foreground">{k.size}</p>
                </div>
              ))}
              <div className="space-y-1">
                <Label htmlFor="snap-watch">While a tab is open</Label>
                <select id="snap-watch" className="h-9 w-full rounded-md border bg-background px-2" disabled={!draft.enabled}
                  value={draft.watchMinutes} onChange={(e) => setDraft({ ...draft, watchMinutes: Number(e.target.value) })}>
                  {[...new Set([...WATCH, draft.watchMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m === 0 ? 'Off' : `Every ${m} minutes`}</option>)}
                </select>
                <p className="text-[11px] text-muted-foreground">The computer checks in every 3 minutes.</p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground max-w-2xl">
              At most {data?.perMinute ?? 120} scheduled snapshots start per minute across the server (SNAPSHOT_MAX_PER_MINUTE), so the
              first round after an upgrade or an outage is spread out. Only the newest automatic snapshot of each kind is kept per
              computer. Sizing: docs/server-sizing.md.
            </p>
            <div className="flex justify-end">
              <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)} data-testid="snapshot-schedule-save">Save</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
