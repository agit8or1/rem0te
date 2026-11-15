'use client';

/**
 * Task progress (0.52): one row per task sent or queued for a computer, with
 * the same steps for every kind — scheduled, approval, queued, handed out,
 * running, done — and the API's own sentence for where it is. The API builds
 * the lifecycle (apps/api/src/tasks/lifecycle.ts); this only draws it.
 *
 * Cancel is offered only where the API says the plan has reached no computer
 * (`cancelJobId`), and goes through the existing POST /actions/:id/cancel.
 */
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Circle, Loader2, X } from 'lucide-react';
import { actionsApi } from '@/lib/api-client';
import { errorMessage } from '@/lib/webauthn';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ITEM_LABEL, ITEM_VARIANT, STATE_LABEL, STATE_VARIANT, STEPS, TYPE_LABEL,
  type TaskStage, type TaskView,
} from '@/lib/tasks';

const ORDER: TaskStage[] = STEPS.map((s) => s.stage);
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

/** The steps that applied to this task, each marked done, current or still to come. */
export function TaskSteps({ t }: { t: TaskView }) {
  const at = ORDER.indexOf(t.stage);
  const steps = STEPS.filter((s) =>
    (s.stage !== 'scheduled' || !!t.scheduledFor) && (s.stage !== 'awaiting_approval' || t.state === 'awaiting_approval' || t.kind === 'action'));
  const bad = ['failed', 'refused', 'uncertain', 'expired', 'canceled', 'not_executed'].includes(t.state);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label="Progress" data-testid="task-steps">
      {steps.map((s, i) => {
        const idx = ORDER.indexOf(s.stage);
        const done = idx < at || (idx === at && s.stage === 'done');
        const current = idx === at && s.stage !== 'done';
        return (
          <li key={s.stage} className="flex items-center gap-1" data-step={s.stage} data-current={current || undefined}>
            {i > 0 && <span className="h-px w-3 bg-border" aria-hidden />}
            {done ? (s.stage === 'done' && bad ? <X className="h-3.5 w-3.5 text-destructive" /> : <Check className="h-3.5 w-3.5 text-green-600" />)
              : current ? (t.overdue ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> : <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />)
                : <Circle className="h-3 w-3 text-muted-foreground/50" />}
            <span className={cn(current ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Per-item results (updates, with HRESULT text where Windows gave one). */
export function TaskItems({ t, max = 50 }: { t: TaskView; max?: number }) {
  if (!t.items.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="task-items">
        <thead className="text-left text-muted-foreground">
          <tr><th className="py-1 pr-3 font-medium">Item</th><th className="py-1 pr-3 font-medium">Result</th><th className="py-1 font-medium">Detail</th></tr>
        </thead>
        <tbody>
          {t.items.slice(0, max).map((it, i) => (
            <tr key={`${it.label}-${i}`} className="border-t align-top">
              <td className="py-1 pr-3">{it.label}</td>
              <td className="py-1 pr-3"><Badge variant={ITEM_VARIANT(it.state)}>{ITEM_LABEL[it.state] ?? it.state}</Badge></td>
              <td className="py-1 text-muted-foreground">{it.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {t.items.length > max && <p className="mt-1 text-xs text-muted-foreground">And {t.items.length - max} more.</p>}
    </div>
  );
}

export function CancelTask({ jobId, onDone }: { jobId: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const m = useMutation({
    mutationFn: () => actionsApi.cancel(jobId),
    onSuccess: () => {
      toast({ title: 'Canceled', description: 'Nothing was handed to the computer.' });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['endpoint-patches'] });
      onDone?.();
    },
    onError: (e) => toast({ title: 'Could not cancel', description: errorMessage(e), variant: 'destructive' }),
  });
  return (
    <Button size="sm" variant="outline" onClick={() => m.mutate()} disabled={m.isPending} data-testid="task-cancel">
      {m.isPending ? 'Canceling…' : 'Cancel'}
    </Button>
  );
}

/** One task: title, state, the steps, the sentence, and (when there are any) the results. */
export function TaskRow({ t, showComputer = false, expanded = false }: { t: TaskView; showComputer?: boolean; expanded?: boolean }) {
  return (
    <li className="space-y-1.5 border-t py-3 first:border-t-0" data-testid="task-row" data-state={t.state} data-type={t.type} data-overdue={t.overdue || undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t.title}</span>
        <Badge variant={STATE_VARIANT[t.state]} data-testid="task-state">{STATE_LABEL[t.state] ?? t.state}</Badge>
        {t.overdue && <Badge variant="warning" data-testid="task-overdue">Overdue</Badge>}
        <span className="text-xs text-muted-foreground">{TYPE_LABEL[t.type] ?? t.type}</span>
        {showComputer && t.computerName && (
          <Link href={`/endpoints/${encodeURIComponent(t.endpointId)}`} className="text-xs text-primary hover:underline">{t.computerName}</Link>
        )}
        <span className="ml-auto flex items-center gap-2">
          {t.cancelJobId && <CancelTask jobId={t.cancelJobId} />}
          <Link href={t.link.href} className="text-xs text-primary hover:underline">{t.link.label}</Link>
        </span>
      </div>
      <TaskSteps t={t} />
      <p className="text-sm text-muted-foreground" data-testid="task-text">{t.text}</p>
      {t.overdue && t.overdueText && <p className="text-sm text-amber-700 dark:text-amber-400">{t.overdueText}</p>}
      <p className="text-xs text-muted-foreground">
        Requested {fmt(t.requestedAt)}
        {t.scheduledFor ? ` · scheduled for ${fmt(t.scheduledFor)}` : ''}
        {t.handedOutAt ? ` · handed out ${fmt(t.handedOutAt)}${t.deliveries > 1 ? ` (${t.deliveries} deliveries)` : ''}` : ''}
        {t.finishedAt ? ` · finished ${fmt(t.finishedAt)}` : ''}
      </p>
      {expanded && <TaskItems t={t} />}
      {!expanded && t.items.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-primary">Results ({t.items.length})</summary>
          <div className="mt-1"><TaskItems t={t} /></div>
        </details>
      )}
    </li>
  );
}

export function LastChecked({ at, fast }: { at?: string; fast: boolean }) {
  if (!at) return null;
  return (
    <span className="text-xs text-muted-foreground" data-testid="tasks-checked">
      Last checked {new Date(at).toLocaleTimeString()} · {fast ? 'checking every 5 s while something is moving' : 'checking every minute'}
    </span>
  );
}
