'use client';

/**
 * Tasks (0.52): everything sent or queued to the computers you can see —
 * approved actions, update installs, restarts, software, scripts, service and
 * process control, snapshots, diagnostics, scans, agent upgrades, migrations
 * and reinstalls — each with the same lifecycle: scheduled, approval, queued,
 * handed out, running, done. Read only; a scheduled or still-unapproved plan
 * can be canceled because it has reached no computer.
 *
 * The API scopes it (endpointVisibilityWhere, computers:view). It polls every
 * 5 s while something is moving and every minute otherwise.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tasksApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { TYPE_LABEL, type TaskList } from '@/lib/tasks';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { LastChecked, TaskRow } from '@/components/tasks/task-ui';

const STATES: { v: string; label: string }[] = [
  { v: 'in_flight', label: 'In progress' }, { v: 'scheduled', label: 'Scheduled' }, { v: 'problem', label: 'Failed or overdue' },
  { v: 'done', label: 'Finished' }, { v: 'all', label: 'All (last 14 days)' },
];
const select = 'flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm';

export default function TasksPage() {
  const { can } = usePermissions();
  const [state, setState] = useState('all');
  const [type, setType] = useState('');
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const s = q.get('state'); if (s && STATES.some((x) => x.v === s)) setState(s);
      const t = q.get('type'); if (t && TYPE_LABEL[t]) setType(t);
    } catch { /* no query */ }
  }, []);
  const { data, isLoading, isError } = useQuery<TaskList>({
    queryKey: ['tasks', 'list', state, type],
    enabled: can(CAP.COMPUTERS_VIEW),
    queryFn: () => tasksApi.list({ state, ...(type ? { type } : {}) }).then((r) => r.data.data as TaskList),
    refetchInterval: (q) => (q.state.data as TaskList | undefined)?.pollMs ?? 60_000,
  });
  if (!can(CAP.COMPUTERS_VIEW)) return <div className="p-6 text-sm text-muted-foreground">You need View computers to see tasks.</div>;
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title="Tasks" description="Everything sent or queued to your computers, and where each one is: scheduled, waiting for approval, queued for the next check-in, handed out, running or done." />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="tasks-state" className="text-xs">Show</Label>
          <select id="tasks-state" className={select} value={state} onChange={(e) => setState(e.target.value)} data-testid="tasks-state">
            {STATES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tasks-type" className="text-xs">Type</Label>
          <select id="tasks-type" className={select} value={type} onChange={(e) => setType(e.target.value)} data-testid="tasks-type">
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {data && (
          <div className="flex flex-wrap items-center gap-2 pb-1">
            <Badge variant="secondary" data-testid="tasks-in-flight">{data.inFlight} in progress</Badge>
            <Badge variant="outline">{data.scheduled} scheduled</Badge>
            {data.overdue > 0 && <Badge variant="warning">{data.overdue} overdue</Badge>}
            <LastChecked at={data.checkedAt} fast={data.pollMs <= 5_000} />
          </div>
        )}
      </div>
      <Card>
        <CardContent className="pt-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {isError && <p className="text-sm text-destructive">Could not load tasks.</p>}
          {data && data.tasks.length === 0 && <p className="text-sm text-muted-foreground" data-testid="tasks-empty">Nothing here.</p>}
          {data && data.tasks.length > 0 && (
            <ul data-testid="tasks-list">{data.tasks.map((t) => <TaskRow key={t.id} t={t} showComputer />)}</ul>
          )}
          {data && (data.total ?? 0) > data.tasks.length && <p className="mt-2 text-xs text-muted-foreground">Showing {data.tasks.length} of {data.total}. Narrow it with the filters.</p>}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Computers check in about every 3 minutes; a task is handed out at the first check-in after it is approved and its start time. Tasks that
        are meant to run unattended — automatic snapshots, the 12-hourly scan — are not listed.
      </p>
    </div>
  );
}
