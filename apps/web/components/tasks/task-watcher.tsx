'use client';

/**
 * A toast when a task you started finishes (0.52), wherever you are in the
 * console, and a count of your tasks still in progress in the top bar. Polls
 * GET /tasks/mine — small on purpose — every 5 s while one of yours is
 * moving, slower otherwise. The first answer only sets where to read from:
 * opening a page is not a task finishing.
 */
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { tasksApi } from '@/lib/api-client';
import { CAP, usePermissions } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { STATE_LABEL, type TaskState } from '@/lib/tasks';

type Mine = {
  now: string; inFlight: number; running: number; pollMs: number;
  finished: { id: string; title: string; computerName: string | null; endpointId: string; state: TaskState; text: string; finishedAt: string; link: { href: string; label: string } }[];
};

export function TaskWatcher() {
  const { can, user } = usePermissions();
  const enabled = !!user && can(CAP.COMPUTERS_VIEW);
  const since = useRef<string | null>(null);
  const told = useRef<Set<string>>(new Set());
  const { toast } = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const { data } = useQuery<Mine>({
    queryKey: ['tasks', 'mine'],
    enabled,
    retry: false,
    // F-9 (0.87): a hidden tab does not poll; react-query refetches when it is shown again, and the toast comes then.
    refetchIntervalInBackground: false,
    refetchInterval: (q) => (q.state.data as Mine | undefined)?.pollMs ?? 15_000,
    queryFn: async () => {
      const r = await tasksApi.mine(since.current ?? undefined);
      return r.data.data as Mine;
    },
  });

  useEffect(() => {
    if (!data) return;
    const first = since.current === null;
    since.current = data.now;
    if (first) { data.finished.forEach((f) => told.current.add(f.id + f.finishedAt)); return; }
    let any = false;
    for (const f of data.finished) {
      const k = f.id + f.finishedAt;
      if (told.current.has(k)) continue;
      told.current.add(k);
      any = true;
      const bad = ['failed', 'refused', 'uncertain', 'expired'].includes(f.state);
      toast({
        title: `${f.title}${f.computerName ? ` · ${f.computerName}` : ''}: ${STATE_LABEL[f.state] ?? f.state}`,
        description: <span data-testid="task-toast">{f.text}</span>,
        variant: bad ? 'destructive' : undefined,
        action: <ToastAction altText={f.link.label} onClick={() => router.push(f.link.href)}>Open</ToastAction>,
      });
    }
    // Whatever is on screen about these tasks is now out of date.
    if (any) {
      void qc.invalidateQueries({ queryKey: ['tasks', 'endpoint'] });
      void qc.invalidateQueries({ queryKey: ['tasks', 'list'] });
      void qc.invalidateQueries({ queryKey: ['endpoint-patches'] });
    }
  }, [data, toast, router, qc]);

  if (!enabled || !data || data.inFlight === 0) return null;
  return (
    <Link href="/automation/tasks?state=in_flight" data-testid="task-watcher" data-in-flight={data.inFlight}
      aria-label={`Your tasks: ${data.inFlight} in progress`} title={`${data.inFlight} of your tasks in progress`}
      className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
      <ListChecks className="h-4 w-4" />
      <span className="font-medium">{data.inFlight}</span>
    </Link>
  );
}
