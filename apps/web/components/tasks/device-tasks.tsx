'use client';

/**
 * The computer page's Tasks panel (0.52): everything sent or queued for this
 * computer in the last two weeks, newest and still-moving first. Polls every
 * 5 s while something is in flight and every minute otherwise (the API says
 * which, `pollMs`). One thin line when nothing is in flight and the list is
 * not opened (0.88).
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { tasksApi } from '@/lib/api-client';
import type { TaskList } from '@/lib/tasks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LastChecked, TaskRow } from './task-ui';

export function DeviceTasks({ endpointId }: { endpointId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isError } = useQuery<TaskList>({
    queryKey: ['tasks', 'endpoint', endpointId],
    queryFn: () => tasksApi.endpoint(endpointId).then((r) => r.data.data as TaskList),
    refetchInterval: (q) => (q.state.data as TaskList | undefined)?.pollMs ?? 60_000,
    retry: false,
  });
  if (isError || !data || data.tasks.length === 0) return null;
  const moving = data.inFlight > 0;
  const shown = open || moving ? data.tasks.filter((t) => open || t.inFlight).slice(0, open ? 20 : 5) : [];
  // 0.88 (P1-2): nothing moving and nothing opened is one thin line, not a card.
  if (shown.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card px-3 py-1.5 text-sm" data-testid="device-tasks" data-in-flight={data.inFlight} data-compact="true">
        <span className="flex items-center gap-2 font-medium"><ListChecks className="h-4 w-4" aria-hidden="true" />Tasks</span>
        <span className="text-xs text-muted-foreground">None in progress</span>
        {data.scheduled > 0 && <Badge variant="outline">{data.scheduled} scheduled</Badge>}
        {data.overdue > 0 && <Badge variant="warning">{data.overdue} overdue</Badge>}
        <span className="ml-auto flex items-center gap-3">
          <span className="hidden md:inline"><LastChecked at={data.checkedAt} fast={data.pollMs <= 5_000} /></span>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(true)} data-testid="device-tasks-toggle">
            <span className="hidden sm:inline">Show recent</span><span className="sm:hidden">Recent</span>&nbsp;({data.tasks.length})
          </Button>
          <Link href={`/automation/tasks`} className="text-xs text-primary hover:underline">All tasks</Link>
        </span>
      </div>
    );
  }
  return (
    <Card data-testid="device-tasks" data-in-flight={data.inFlight}>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><ListChecks className="h-4 w-4" />Tasks</CardTitle>
        {moving ? <Badge variant="secondary" data-testid="device-tasks-chip">{data.inFlight} in progress</Badge> : <Badge variant="outline">None in progress</Badge>}
        {data.scheduled > 0 && <Badge variant="outline">{data.scheduled} scheduled</Badge>}
        {data.overdue > 0 && <Badge variant="warning">{data.overdue} overdue</Badge>}
        <span className="ml-auto flex items-center gap-3">
          <LastChecked at={data.checkedAt} fast={data.pollMs <= 5_000} />
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen((v) => !v)} data-testid="device-tasks-toggle">
            {open ? 'Show in progress only' : `Show recent (${data.tasks.length})`}
          </Button>
          <Link href={`/automation/tasks`} className="text-xs text-primary hover:underline">All tasks</Link>
        </span>
      </CardHeader>
      {shown.length > 0 && (
        <CardContent className="pt-0">
          <ul>{shown.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
        </CardContent>
      )}
    </Card>
  );
}
