'use client';

/**
 * Automation schedules (0.58, docs/automation.md): a library script or a
 * catalog package run on a recurring schedule. Each schedule is a policy
 * two people approve once with passkeys on the approval signer (or, in
 * direct mode, active at once); every run is then signed there under it,
 * and nothing on this page can approve or run anything.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Plus } from 'lucide-react';
import { automationApi, businessesApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { StatusBadge, apiMessage, selectClass, when, type Occurrence } from '@/components/automation/schedule-ui';

interface Row {
  id: string; name: string; businessId: string; businessName: string; status: string; paused: boolean; taskKind: 'script' | 'software'; task: string;
  targets: string; schedule: string; offline: string; nextRun: Occurrence | null; lastRun: string | null; succeeded: number; failed: number; expiresAt: string;
  lastProposal: { ok: boolean; code: string; message: string; at: string } | null;
}
interface ListData {
  readiness: { signerConfigured: boolean; signerSupportsAutomation: boolean; sweep: { enabled: boolean; everySeconds: number }; why: string | null };
  schedules: Row[];
}

export default function SchedulesPage() {
  const { can, isPlatformAdmin } = usePermissions();
  const [picked, setPicked] = useState('');
  const { data: businesses = [] } = useQuery({
    queryKey: ['businesses', ''],
    enabled: isPlatformAdmin,
    queryFn: () => businessesApi.list().then((r) => ((r.data as { data?: { id: string; name: string }[] })?.data ?? [])),
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['automation-schedules', picked],
    enabled: can(CAP.COMPUTERS_VIEW),
    queryFn: () => automationApi.list(picked || null).then((r) => r.data.data as ListData),
    retry: false,
    refetchInterval: 30_000,
  });
  if (!can(CAP.COMPUTERS_VIEW)) return <div className="p-6 text-sm text-muted-foreground">You need View computers to see automation schedules.</div>;
  const ready = data?.readiness;
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Schedules" description="Library scripts and catalog software run on a recurring schedule: approved once on the approval signer, and every run signed there under it.">
        {ready?.signerSupportsAutomation && <Button size="sm" asChild><Link href={`/automation/schedules/new${picked ? `?business=${picked}` : ''}`} data-testid="schedule-new"><Plus className="h-4 w-4 mr-1" />New schedule</Link></Button>}
      </PageHeader>
      {isPlatformAdmin && (
        <div className="max-w-xs space-y-1">
          <Label htmlFor="sched-biz" className="text-xs">Business</Label>
          <select id="sched-biz" className={selectClass} value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">All businesses</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}
      {ready && ready.why && <p className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs dark:border-yellow-800 dark:bg-yellow-950/40" data-testid="schedule-not-ready">{ready.why}</p>}
      {ready && !ready.sweep.enabled && <p className="rounded-md border p-3 text-xs" data-testid="schedule-sweep-off">The automation sweep is off on this server (AUTOMATION_SWEEP=off): no schedule asks for a run until it is turned back on.</p>}
      <div className="max-w-4xl rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p>
          A schedule names one approved library script (its exact SHA-256 and arguments) or one catalog package version, the computers or device group it runs on, when it runs, and what happens to a computer that is offline.
          Two approvers who are not its author (and, for a script, did not write it) approve it once on the approval signer. Each run is then a separate signed plan, which the signer checks against the schedule: the right task, the right computers, inside the window, one run at a time.
        </p>
        <p>Pausing stops it at once. Revoking the script on the allowlist, archiving the package, a containment pause on actions, or revoking the schedule stops every later run. Changing anything is a new revision, approved again.</p>
      </div>
      <Card>
        <CardContent className="pt-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive" data-testid="schedules-error">{apiMessage(error, 'Could not load schedules.')}</p>}
          {data && data.schedules.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground" data-testid="schedules-empty">
              <CalendarClock className="mx-auto mb-2 h-6 w-6" />
              No schedules yet. {ready?.signerSupportsAutomation ? 'Make one from an approved script or a catalog package.' : ''}
            </div>
          )}
          {data && data.schedules.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="schedules-list">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="px-2 py-1">Schedule</th><th className="px-2 py-1">Runs</th><th className="px-2 py-1">Next run</th><th className="px-2 py-1">Last run</th><th className="px-2 py-1">Results</th></tr>
                </thead>
                <tbody>
                  {data.schedules.map((r) => (
                    <tr key={r.id} className="border-t align-top" data-schedule-id={r.id}>
                      <td className="px-2 py-2">
                        <Link className="font-medium hover:underline" href={`/automation/schedules/${r.id}`}>{r.name}</Link>
                        <div className="mt-1"><StatusBadge status={r.status} paused={r.paused} /></div>
                        {isPlatformAdmin && !picked && <p className="text-xs text-muted-foreground">{r.businessName}</p>}
                      </td>
                      <td className="px-2 py-2 text-xs">{r.task}<br /><span className="text-muted-foreground">{r.targets} · {r.schedule}</span></td>
                      <td className="px-2 py-2 text-xs whitespace-nowrap">{r.nextRun ? when(r.nextRun) : '—'}</td>
                      <td className="px-2 py-2 text-xs whitespace-nowrap">{r.lastRun ? formatDate(r.lastRun) : 'Never'}
                        {r.lastProposal && !r.lastProposal.ok && <p className="text-yellow-700 dark:text-yellow-400 whitespace-normal max-w-xs">{r.lastProposal.message}</p>}
                      </td>
                      <td className="px-2 py-2 text-xs whitespace-nowrap">{r.succeeded} succeeded · {r.failed} failed</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Schedules have been tested against a simulated agent, not yet on a real Windows computer. Computers check in about every 3 minutes; a run is handed out at the first check-in inside its window.</p>
    </div>
  );
}
