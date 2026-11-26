'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Flag } from 'lucide-react';
import { FP_REASONS, qualityApi, type FpReason } from '@/lib/api-client';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { apiError } from '@/components/security-controls/shared';

/**
 * Report False Positive (0.67).
 *
 * Marking one alert as a false positive is a record — it may resolve that one
 * alert, and it may count towards a recommendation. It never changes a monitor
 * and never creates a rule: a rule is proposed, tested against stored history
 * and approved on Monitoring → False positives & rules. The dialog says so twice,
 * because the difference is the whole point.
 */

type Context = {
  alert: { id: string; title: string; severity: string; state: string; kind: string; monitor: string; firstSeenAt: string; lastSeenAt: string; occurrences: number; fingerprint: string | null };
  rawEvent: { provider?: string | null; eventId?: number | null; level?: number | null; message?: string; statusCode?: string | null; component?: string | null } | null;
  monitor: { key: string; name: string; severity: string; log: string | null };
  classification: { class: string; basis: string; matched: string | null } | null;
  similar: { count: number; businesses: number; computers: { id: string | null; name: string | null; alerts: number }[] };
  falsePositive: { reports: number; mine: { reason: string; createdAt: string } | null; openRecommendation: { id: string; reportCount: number } | null };
  proposedHandling: { title: string; issue: string; recommendation: string; impact: string; caution: string; note: string; draft: unknown };
};

export function ReportFalsePositiveButton({ alertId, onDone }: { alertId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="fp-open"><Flag className="mr-1 h-4 w-4" />Report false positive</Button>
      {open && <FalsePositiveDialog alertId={alertId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />}
    </>
  );
}

export function FalsePositiveDialog({ alertId, onClose, onDone }: { alertId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<FpReason | ''>('');
  const [comment, setComment] = useState('');
  const [recommend, setRecommend] = useState(false);
  const [resolve, setResolve] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data, error } = useQuery<Context>({ queryKey: ['fp-context', alertId], queryFn: () => qualityApi.fpContext(alertId).then((r) => r.data.data), retry: false });
  const send = useMutation({
    mutationFn: () => qualityApi.report(alertId, { reason: reason as FpReason, comment: comment.trim() || undefined, recommendPrevent: recommend, resolve }),
    onSuccess: onDone, onError: (e) => setErr(apiError(e).message),
  });
  const needsComment = reason === 'other' && comment.trim().length < 3;
  const already = !!data?.falsePositive.mine;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="fp-dialog">
        <DialogHeader>
          <DialogTitle>Report false positive</DialogTitle>
          <DialogDescription>
            This records that this alert was not a real problem. It does not turn off the monitor and does not change any rule.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{apiError(error).message}</p>}
        {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {data && (
          <div className="min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]">
            <section className="rounded-md border p-2" data-testid="fp-alert">
              <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{data.alert.severity.toLowerCase()}</Badge><span className="font-medium">{data.alert.title}</span></div>
              <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Monitor</dt><dd>{data.monitor.name} (<code>{data.monitor.key}</code>, {data.monitor.severity.toLowerCase()}{data.monitor.log ? `, ${data.monitor.log} log` : ''})</dd>
                {data.classification && <><dt className="text-muted-foreground">Classification</dt><dd>{data.classification.class.toLowerCase()} ({data.classification.basis.replace(/_/g, ' ')}{data.classification.matched ? `: ${data.classification.matched}` : ''})</dd></>}
                <dt className="text-muted-foreground">Similar alerts</dt><dd data-testid="fp-similar">{data.similar.count} you can see, on {data.similar.computers.length} device{data.similar.computers.length === 1 ? '' : 's'}{data.similar.businesses > 1 ? ` in ${data.similar.businesses} customers` : ''}{data.similar.computers.length ? `: ${data.similar.computers.slice(0, 5).map((c) => `${c.name ?? c.id} (${c.alerts})`).join(', ')}` : ''}</dd>
                <dt className="text-muted-foreground">Reports so far</dt><dd>{data.falsePositive.reports}{data.falsePositive.openRecommendation ? ` · an open recommendation has ${data.falsePositive.openRecommendation.reportCount}` : ''}</dd>
              </dl>
              {data.rawEvent && (
                <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted-foreground">The original event</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2" data-testid="fp-raw">{JSON.stringify(data.rawEvent, null, 2)}</pre>
                </details>
              )}
            </section>

            {already ? (
              <p className="text-muted-foreground" data-testid="fp-already">You reported this alert on {new Date(data.falsePositive.mine!.createdAt).toLocaleString()}.</p>
            ) : (
              <>
                <fieldset className="space-y-1" data-testid="fp-reasons">
                  <legend className="mb-1 text-sm font-medium">Why is it a false positive?</legend>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {FP_REASONS.map(([k, l]) => (
                      <label key={k} className="flex items-center gap-2 rounded border p-1.5 text-sm"><input type="radio" name={`fp-reason-${alertId}`} value={k} checked={reason === k} onChange={() => setReason(k)} />{l}</label>
                    ))}
                  </div>
                </fieldset>
                <div className="space-y-1">
                  <Label htmlFor={`fp-comment-${alertId}`}>Comments{reason === 'other' ? ' (required)' : ''}</Label>
                  <Textarea id={`fp-comment-${alertId}`} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What makes it harmless: a known vendor issue, a scheduled job, a ticket…" />
                </div>
                <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={resolve} onChange={(e) => setResolve(e.target.checked)} data-testid="fp-resolve" /><span>Also resolve this alert <span className="text-muted-foreground">(only this one)</span></span></label>
                <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={recommend} onChange={(e) => setRecommend(e.target.checked)} data-testid="fp-recommend" />
                  <span>Recommend preventing similar alerts in the future <span className="block text-xs text-muted-foreground">Adds your report to a recommendation. Someone who configures monitoring reviews it, tests a rule against stored history and approves it before anything changes.</span></span>
                </label>
                {recommend && (
                  <section className="rounded-md border border-dashed p-2" data-testid="fp-proposed">
                    <div className="text-xs font-medium">{data.proposedHandling.title} (a suggestion)</div>
                    <p className="text-xs text-muted-foreground">{data.proposedHandling.recommendation}</p>
                    <p className="text-xs text-muted-foreground">{data.proposedHandling.impact}</p>
                    <p className="text-xs text-amber-700 dark:text-amber-400">{data.proposedHandling.caution}</p>
                  </section>
                )}
              </>
            )}
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {data && !already && <Button disabled={!reason || needsComment || send.isPending} onClick={() => send.mutate()} data-testid="fp-submit">{resolve ? 'Report and resolve' : 'Report'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
