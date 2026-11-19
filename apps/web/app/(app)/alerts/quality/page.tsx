'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FlaskConical, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import { FP_REASONS, qualityApi, type QualityBehaviour, type QualityDraft, type QualityFilters, type QualityScope } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { reauthSuffix, useAsks } from '@/lib/confirm-policy';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiError } from '@/components/security-controls/shared';

/**
 * False Positives & Rule Improvements (0.67).
 *
 * Reports of false positives, the recommendations they add up to, the alert
 * quality rules (proposed, tested, approved, rolled back) and the
 * monitoring-quality checks. Nothing on this page changes a monitor: a rule
 * changes what a monitor raises in one scope, and only after it was tested
 * against stored history and approved. Each page section reads its own API,
 * which checks the person's scope again.
 */

type Totals = { reports: number; pendingRecommendations: number; pendingRules: number; approvedRules: number; temporaryExceptions: number; expiringSoon: number; reviewDue: number; noisePrevented: number; shadowMatches: number };
type Summary = {
  totals: Totals;
  top: { monitors: { key: string; reports: number }[]; computers: { id: string | null; name: string | null; reports: number }[]; businesses: { id: string | null; name: string | null; reports: number }[]; reasons: { reason: string; label: string; reports: number }[] };
  trend: { weekStart: string; alerts: number; falsePositives: number; accuracy: number | null }[];
};
type Draft = { scope: QualityScope; match: QualityDraft['match']; behaviour: QualityBehaviour };
type Rec = {
  id: string; status: string; monitorKey: string; fingerprint: string | null; businessId: string | null; business: string | null; reportCount: number; reporters: number; computers: number;
  priority: number; lastReportedAt: string; title: string; monitor: string; issue: string; recommendation: string; impact: string; caution: string; draft: Draft | null;
};
type Sim = {
  considered: number; matched: number; wouldSuppress: number; wouldDowngrade: number; unchanged: number; days: number; truncated: boolean; current?: boolean; at: string;
  dangerous: { alertId: string; title: string; reason: string }[]; businesses: { id: string | null; alerts: number }[]; computers: { id: string | null; alerts: number }[];
  events: { fingerprints: number; occurrences: number }; changes: { alertId: string; title: string; before: string; after: string | null; state: string; at: string }[];
};
type Rule = {
  id: string; name: string; description: string; justification: string; status: string; revision: number; risk: string; riskReasons: string[];
  scope: { kind: string; label: string; businessId: string | null; endpointId: string | null; groupId: string | null; monitorRuleId: string | null; osFamily: string | null };
  monitor: string; match: QualityDraft['match']; behaviour: QualityBehaviour; temporary: boolean; expiresAt: string | null; reviewAt: string | null; reviewOverdue: boolean; allowBroad: boolean;
  simulation: Sim | null; createdBy: string; createdAt: string; approvedBy: string | null; secondApprovedBy: string | null; awaitingSecondApproval: boolean; mayApproveSecond: boolean;
  rejectedBy: string | null; rolledBackBy: string | null; closedNote: string | null; supersedesId: string | null;
  matchCount: number; lastMatchedAt: string | null; shadowMatchCount: number; dangerousMatchCount: number;
  mayManage?: boolean; history?: { id: string; type: string; by: string | null; revision: number; at: string; detail: Record<string, unknown> | null }[];
  versions?: { id: string; name: string; status: string; relation: string }[];
};
type Check = { code: string; level: 'high' | 'medium' | 'low'; monitor: { key: string; name: string } | null; ruleIds: string[]; message: string; recommendation: string };
type Report = { id: string; alertId: string | null; title: string; monitor: string; severity: string; reasonLabel: string; comment: string | null; recommendPrevent: boolean; computer: { id: string; name: string | null } | null; reportedBy: string; reportedById: string; at: string };

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
const behaviourText = (b: QualityBehaviour) => b.kind === 'suppress' ? 'Suppress (events still recorded)' : b.kind === 'downgrade' ? `Lower to ${b.severity.toLowerCase()}` : b.kind === 'require_count' ? `Alert only at ${b.minCount}+ in one report` : `Alert only after ${b.reports} reports`;
const STATUS_TONE: Record<string, string> = { active: 'bg-emerald-600 text-white hover:bg-emerald-600', pending: 'bg-amber-500 text-black hover:bg-amber-500' };

export default function QualityPage() {
  const { user, can, isPlatformAdmin, isBusinessOwner, businessId } = usePermissions();
  const configure = isBusinessOwner || can('monitoring:configure' as never);
  const [f, setF] = useState<QualityFilters>({});
  const [openRule, setOpenRule] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ draft: Partial<QualityDraft>; editId?: string; revision?: number } | null>(null);
  const [ruleStatus, setRuleStatus] = useState('');
  useEffect(() => { const r = new URLSearchParams(window.location.search).get('rule'); if (r && /^[A-Za-z0-9_-]{8,64}$/.test(r)) setOpenRule(r); }, []);

  const summary = useQuery<Summary>({ queryKey: ['q-summary', f], queryFn: () => qualityApi.summary(f).then((r) => r.data.data), enabled: !!user, retry: false });
  const recs = useQuery<{ recommendations: Rec[] }>({ queryKey: ['q-recs', f], queryFn: () => qualityApi.recommendations(f).then((r) => r.data.data), enabled: !!user, retry: false });
  const rules = useQuery<{ rules: Rule[] }>({ queryKey: ['q-rules', ruleStatus, f.monitor], queryFn: () => qualityApi.rules({ status: ruleStatus || undefined, monitor: f.monitor }).then((r) => r.data.data), enabled: !!user, retry: false });
  const checks = useQuery<{ checks: Check[]; note: string; monitorsChecked: number }>({ queryKey: ['q-checks', f.monitor], queryFn: () => qualityApi.checks({ monitor: f.monitor }).then((r) => r.data.data), enabled: !!user, retry: false });
  const reports = useQuery<{ reports: Report[] }>({ queryKey: ['q-reports', f], queryFn: () => qualityApi.reports({ ...f, limit: 50 }).then((r) => r.data.data), enabled: !!user, retry: false });
  const technicians = useMemo(() => [...new Map((reports.data?.reports ?? []).map((r) => [r.reportedById, r.reportedBy])).entries()], [reports.data]);

  if (!user) return null;
  const t = summary.data?.totals;
  const set = (k: keyof QualityFilters, v: string) => setF((o) => ({ ...o, [k]: v || undefined }));

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="False Positives & Rule Improvements"
        description="Reports of alerts that were not real problems, the improvements they suggest, and the approved rules that change what a monitor raises. Nothing here turns a monitor off."
        actions={configure ? <Button onClick={() => setEditor({ draft: { scope: businessId ? { kind: 'business', businessId } : { kind: 'endpoint' }, behaviour: { kind: 'suppress' }, temporary: false } })} data-testid="q-new-rule">Propose a rule</Button> : undefined}
      />
      {summary.error && <p className="text-sm text-muted-foreground">{apiError(summary.error).message}</p>}

      <div className="flex flex-wrap items-end gap-3" data-testid="q-filters">
        <div className="space-y-1"><Label htmlFor="q-mon">Monitor</Label><Input id="q-mon" className="w-40" placeholder="any (key)" value={f.monitor ?? ''} onChange={(e) => set('monitor', e.target.value.trim())} /></div>
        <div className="space-y-1"><Label htmlFor="q-sev">Severity</Label>
          <select id="q-sev" className="rounded-md border bg-background p-2 text-sm" value={f.severity ?? ''} onChange={(e) => set('severity', e.target.value)}><option value="">Any</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></div>
        <div className="space-y-1"><Label htmlFor="q-reason">Reason</Label>
          <select id="q-reason" className="rounded-md border bg-background p-2 text-sm" value={f.reason ?? ''} onChange={(e) => set('reason', e.target.value)}><option value="">Any</option>{FP_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="space-y-1"><Label htmlFor="q-status">Recommendations</Label>
          <select id="q-status" className="rounded-md border bg-background p-2 text-sm" value={f.status ?? ''} onChange={(e) => set('status', e.target.value)}><option value="">Open</option><option value="converted">Made into a rule</option><option value="dismissed">Dismissed</option></select></div>
        <div className="space-y-1"><Label htmlFor="q-tech">Technician</Label>
          <select id="q-tech" className="rounded-md border bg-background p-2 text-sm" value={f.reportedBy ?? ''} onChange={(e) => set('reportedBy', e.target.value)}><option value="">Anyone</option>{technicians.map(([id, email]) => <option key={id} value={id}>{email}</option>)}</select></div>
        <div className="space-y-1"><Label htmlFor="q-from">From</Label><Input id="q-from" type="date" value={f.from?.slice(0, 10) ?? ''} onChange={(e) => set('from', e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : '')} /></div>
        <div className="space-y-1"><Label htmlFor="q-to">To</Label><Input id="q-to" type="date" value={f.to?.slice(0, 10) ?? ''} onChange={(e) => set('to', e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : '')} /></div>
        {f.endpointId && <Button size="sm" variant="ghost" onClick={() => set('endpointId', '')}>Every computer</Button>}
      </div>

      {t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8" data-testid="q-totals">
          {([['False-positive reports', t.reports], ['Pending recommendations', t.pendingRecommendations], ['Rules awaiting approval', t.pendingRules], ['Approved rules', t.approvedRules],
            ['Temporary exceptions', t.temporaryExceptions], ['Expiring in 7 days', t.expiringSoon], ['Review due', t.reviewDue], ['Alerts prevented', t.noisePrevented]] as [string, number][]).map(([l, n]) => (
            <Card key={l}><CardContent className="pt-4"><div className="text-2xl font-semibold">{n}</div><div className="text-xs text-muted-foreground">{l}</div></CardContent></Card>
          ))}
        </div>
      )}

      {summary.data && (
        <div className="grid gap-3 lg:grid-cols-4" data-testid="q-top">
          <TopList title="Most reported monitors" rows={summary.data.top.monitors.map((m) => [m.key, m.reports, () => set('monitor', m.key)])} />
          <TopList title="Most reported computers" rows={summary.data.top.computers.map((c) => [c.name ?? c.id ?? '—', c.reports, c.id ? () => set('endpointId', c.id!) : undefined])} />
          <TopList title="Most reported businesses" rows={summary.data.top.businesses.map((b) => [b.name ?? '—', b.reports, undefined])} />
          <TopList title="Reasons" rows={summary.data.top.reasons.map((r) => [r.label, r.reports, () => set('reason', r.reason)])} />
        </div>
      )}

      {summary.data && (
        <Card data-testid="q-trend">
          <CardHeader className="pb-2"><CardTitle className="text-base">Alert accuracy, week by week</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto text-xs">
            <p className="mb-2 text-muted-foreground">Of the alerts raised each week, the share nobody reported as a false positive. Unreported is not the same as confirmed.</p>
            <div className="flex min-w-[36rem] items-end gap-1" role="list">
              {summary.data.trend.map((w) => (
                <div key={w.weekStart} role="listitem" className="flex flex-1 flex-col items-center gap-1" title={`${w.weekStart}: ${w.alerts} alerts, ${w.falsePositives} reported`}>
                  <span>{w.accuracy === null ? '—' : `${w.accuracy}%`}</span>
                  <div className="w-full rounded-sm bg-primary/70" style={{ height: `${w.accuracy === null ? 2 : Math.max(2, w.accuracy * 0.6)}px` }} />
                  <span className="text-muted-foreground">{w.weekStart.slice(5)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <section className="space-y-2" data-testid="q-recommendations">
        <h2 className="text-lg font-semibold">Recommendations</h2>
        {recs.error && <p className="text-sm text-muted-foreground">{apiError(recs.error).message}</p>}
        {recs.data && recs.data.recommendations.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Nothing to review.</p>}
        <div className="grid gap-3 lg:grid-cols-2">
          {recs.data?.recommendations.map((r) => <RecCard key={r.id} r={r} configure={configure} onPropose={(d) => setEditor({ draft: d })} />)}
        </div>
      </section>

      <section className="space-y-2" data-testid="q-rules">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Alert quality rules</h2>
          <select aria-label="Rule status" className="ml-auto rounded-md border bg-background p-2 text-sm" value={ruleStatus} onChange={(e) => setRuleStatus(e.target.value)}>
            <option value="">Every status</option><option value="pending">Awaiting approval</option><option value="active">Active</option><option value="rolled_back">Rolled back</option><option value="expired">Expired</option><option value="superseded">Superseded</option><option value="rejected">Rejected</option>
          </select>
        </div>
        {rules.error && <p className="text-sm text-muted-foreground">{apiError(rules.error).message}</p>}
        <Card>
          <CardContent className="p-0 text-sm">
            {rules.data && rules.data.rules.length === 0 && <p className="p-3 text-muted-foreground">No rules.</p>}
            {rules.data?.rules.map((r) => (
              <div key={r.id} className="border-b last:border-b-0">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 p-3 text-left hover:bg-accent/50" aria-expanded={openRule === r.id} onClick={() => setOpenRule(openRule === r.id ? null : r.id)} data-testid="q-rule-row">
                  <Badge className={STATUS_TONE[r.status]} variant={STATUS_TONE[r.status] ? 'default' : 'outline'}>{r.awaitingSecondApproval ? 'awaiting 2nd approval' : r.status.replace('_', ' ')}</Badge>
                  {r.risk === 'high' && <Badge variant="destructive">high risk</Badge>}
                  {r.reviewOverdue && <Badge variant="outline">review overdue</Badge>}
                  <span className="font-medium">{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.monitor} · {r.scope.label} · {behaviourText(r.behaviour)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{r.status === 'pending' ? `${r.shadowMatchCount} shadow matches` : `${r.matchCount} matched`}</span>
                </button>
                {openRule === r.id && <RuleDetail id={r.id} onRevise={(d) => setEditor(d)} />}
              </div>
            ))}
          </CardContent>
        </Card>
        {openRule && rules.data && !rules.data.rules.some((r) => r.id === openRule) && <Card><CardContent className="p-0 text-sm"><RuleDetail id={openRule} onRevise={(d) => setEditor(d)} /></CardContent></Card>}
      </section>

      <section className="space-y-2" data-testid="q-checks">
        <h2 className="text-lg font-semibold">Monitoring quality</h2>
        <p className="text-sm text-muted-foreground">{checks.data?.note ?? 'Recommendations only.'}{checks.data ? ` ${checks.data.monitorsChecked} monitors checked.` : ''}</p>
        {checks.error && <p className="text-sm text-muted-foreground">{apiError(checks.error).message}</p>}
        {checks.data && checks.data.checks.length === 0 && <p className="text-sm text-muted-foreground">Nothing stands out.</p>}
        <ul className="space-y-2">
          {checks.data?.checks.map((c, i) => (
            <li key={`${c.code}-${i}`} className="rounded-md border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><Badge variant={c.level === 'high' ? 'destructive' : 'outline'}>{c.level}</Badge><span className="font-medium">{c.message}</span></div>
              <p className="text-muted-foreground">{c.recommendation}</p>
              {c.ruleIds.length > 0 && <p className="text-xs">{c.ruleIds.map((id) => <button key={id} type="button" className="mr-2 text-primary hover:underline" onClick={() => setOpenRule(id)}>Open rule</button>)}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2" data-testid="q-reports">
        <h2 className="text-lg font-semibold">Reports</h2>
        <Card>
          <CardContent className="p-0 text-sm">
            {reports.data && reports.data.reports.length === 0 && <p className="p-3 text-muted-foreground">No reports.</p>}
            {reports.data?.reports.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 border-b p-3 last:border-b-0">
                <Badge variant="outline">{r.severity.toLowerCase()}</Badge>
                <span className="font-medium">{r.alertId ? <Link className="hover:underline" href={`/alerts?alert=${r.alertId}`}>{r.title}</Link> : r.title}</span>
                <Badge variant="secondary">{r.reasonLabel}</Badge>
                {r.recommendPrevent && <Badge variant="outline">recommends prevention</Badge>}
                {r.comment && <span className="min-w-0 basis-full text-muted-foreground [overflow-wrap:anywhere]">“{r.comment}”</span>}
                <span className="ml-auto text-xs text-muted-foreground">{r.computer?.name ?? ''} · {r.reportedBy} · {fmt(r.at)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      {editor && <RuleEditor init={editor} isPlatformAdmin={isPlatformAdmin} businessId={businessId} onClose={() => setEditor(null)} onSaved={(id) => { setEditor(null); setOpenRule(id); }} />}
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: [string, number, (() => void) | undefined][] }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="text-sm">
        {rows.length === 0 && <p className="text-muted-foreground">None.</p>}
        <ul className="space-y-0.5">
          {rows.map(([l, n, go], i) => <li key={`${l}-${i}`} className="flex min-w-0 gap-2"><span className="min-w-0 flex-1 truncate">{go ? <button type="button" className="text-left text-primary hover:underline" onClick={go}>{l}</button> : l}</span><span className="text-muted-foreground">{n}</span></li>)}
        </ul>
      </CardContent>
    </Card>
  );
}

function SimView({ s }: { s: Sim }) {
  return (
    <div className="space-y-1 rounded-md border bg-background p-2 text-xs" data-testid="q-sim">
      <p>Over the last {s.days} days: <b>{s.matched}</b> of {s.considered} alerts in scope match — {s.wouldSuppress} would not have been raised, {s.wouldDowngrade} lowered, {s.unchanged} unchanged. {s.events.fingerprints} recorded event signature{s.events.fingerprints === 1 ? '' : 's'} ({s.events.occurrences} occurrences) match.{s.truncated ? ' Only the newest 5,000 were read.' : ''}</p>
      <p>Businesses: {s.businesses.length || 'none'} · computers: {s.computers.length || 'none'}{s.current === false ? ' · this test is for an older revision or over a week old: test again' : ''}</p>
      {s.dangerous.length > 0 && (
        <div className="rounded border border-destructive/50 p-1.5 text-destructive" data-testid="q-sim-dangerous">
          <p className="flex items-center gap-1 font-medium"><AlertTriangle className="h-3 w-3" />{s.dangerous.length} dangerous match{s.dangerous.length === 1 ? '' : 'es'}: the classifier knows these as genuine failures, or they are Security-log events.</p>
          <ul className="list-disc pl-4">{s.dangerous.slice(0, 10).map((d) => <li key={d.alertId}><Link className="hover:underline" href={`/alerts?alert=${d.alertId}`}>{d.title}</Link> — {d.reason}</li>)}</ul>
        </div>
      )}
      {s.changes.length > 0 && (
        <details><summary className="cursor-pointer text-muted-foreground">Before and after ({s.changes.length})</summary>
          <ul className="mt-1 space-y-0.5">{s.changes.map((c) => <li key={c.alertId}>{c.before.toLowerCase()} → {c.after ? c.after.toLowerCase() : 'not raised'} · {c.title} · {fmt(c.at)}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function RecCard({ r, configure, onPropose }: { r: Rec; configure: boolean; onPropose: (d: Partial<QualityDraft>) => void }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Sim | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const pv = useMutation({ mutationFn: () => qualityApi.preview(r.id).then((x) => x.data.data), onSuccess: (d: { simulation: Sim | null }) => setPreview(d.simulation), onError: (e) => setErr(apiError(e).message) });
  const dis = useMutation({ mutationFn: () => qualityApi.dismiss(r.id, note.trim()), onSuccess: () => { qc.invalidateQueries({ queryKey: ['q-recs'] }); qc.invalidateQueries({ queryKey: ['q-summary'] }); }, onError: (e) => setErr(apiError(e).message) });
  const propose = () => r.draft && onPropose({
    name: `${r.monitor}: ${r.draft.behaviour.kind === 'suppress' ? 'exclude' : 'adjust'} a known signature`.slice(0, 120),
    description: r.recommendation.slice(0, 500), justification: `${r.issue}`.slice(0, 1000), scope: r.draft.scope, match: r.draft.match, behaviour: r.draft.behaviour, temporary: false, recommendationId: r.id,
  });
  return (
    <Card data-testid="q-rec" data-monitor={r.monitorKey}>
      <CardHeader className="pb-2"><CardTitle className="flex flex-wrap items-center gap-2 text-base">{r.title}<Badge variant="outline">priority {r.priority}</Badge></CardTitle></CardHeader>
      <CardContent className="min-w-0 space-y-1.5 text-sm [overflow-wrap:anywhere]">
        <p><span className="text-muted-foreground">Monitor:</span> {r.monitor} (<code>{r.monitorKey}</code>){r.business ? ` · ${r.business}` : ''}</p>
        <p><span className="text-muted-foreground">Issue:</span> {r.issue}</p>
        <p><span className="text-muted-foreground">Recommendation:</span> {r.recommendation}</p>
        <p><span className="text-muted-foreground">Impact:</span> {r.impact}</p>
        <p className="text-amber-700 dark:text-amber-400"><span className="font-medium">Caution:</span> {r.caution}</p>
        <p className="text-xs text-muted-foreground">{r.reportCount} report{r.reportCount === 1 ? '' : 's'} by {r.reporters} {r.reporters === 1 ? 'person' : 'people'} on {r.computers} computer{r.computers === 1 ? '' : 's'}; last {fmt(r.lastReportedAt)}. More reports raise its priority; they never approve anything.</p>
        {r.status === 'open' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {r.draft && <Button size="sm" variant="outline" disabled={pv.isPending} onClick={() => pv.mutate()}><FlaskConical className="mr-1 h-4 w-4" />Preview matching events</Button>}
            {configure && r.draft && <Button size="sm" onClick={propose} data-testid="q-rec-propose">Edit scope and propose</Button>}
            {configure && <Button size="sm" variant="ghost" onClick={() => setDismissing(!dismissing)}>Dismiss</Button>}
          </div>
        )}
        {dismissing && (
          <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" placeholder="Why (at least 3 characters)" value={note} onChange={(e) => setNote(e.target.value)} /><Button size="sm" variant="destructive" disabled={note.trim().length < 3 || dis.isPending} onClick={() => dis.mutate()}>Dismiss recommendation</Button></div>
        )}
        {preview && <SimView s={preview} />}
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function RuleDetail({ id, onRevise }: { id: string; onRevise: (d: { draft: Partial<QualityDraft>; editId?: string; revision?: number }) => void }) {
  const qc = useQueryClient();
  const ask = useAsks('monitoring.qualityrule');
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [accept, setAccept] = useState(false);
  const [closing, setClosing] = useState<'reject' | 'rollback' | null>(null);
  const [note, setNote] = useState('');
  const { data: r, error } = useQuery<Rule>({ queryKey: ['q-rule', id], queryFn: () => qualityApi.rule(id).then((x) => x.data.data), retry: false });
  const refresh = () => { setErr(null); qc.invalidateQueries({ queryKey: ['q-rule', id] }); qc.invalidateQueries({ queryKey: ['q-rules'] }); qc.invalidateQueries({ queryKey: ['q-summary'] }); };
  const sim = useMutation({ mutationFn: () => qualityApi.simulate(id), onSuccess: refresh, onError: (e) => setErr(apiError(e).message) });
  const appr = useMutation({ mutationFn: () => qualityApi.approve(id, r!.revision, accept), onSuccess: () => { setConfirm(false); refresh(); }, onError: (e) => { setConfirm(false); setErr(apiError(e).message); } });
  const close = useMutation({ mutationFn: () => (closing === 'reject' ? qualityApi.reject(id, note.trim()) : qualityApi.rollback(id, note.trim())), onSuccess: () => { setClosing(null); setNote(''); refresh(); }, onError: (e) => setErr(apiError(e).message) });
  if (error) return <p className="p-3 text-muted-foreground">{apiError(error).message}</p>;
  if (!r) return <p className="p-3 text-muted-foreground">Loading…</p>;
  const manage = !!r.mayManage;
  const sim0 = r.simulation;
  const draftOf = (): Partial<QualityDraft> => ({ name: r.name, description: r.description, justification: r.justification, scope: scopeInput(r), match: r.match, behaviour: r.behaviour, temporary: r.temporary, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), ...(r.reviewAt ? { reviewAt: r.reviewAt } : {}) });

  return (
    <div className="min-w-0 space-y-3 bg-muted/30 px-3 pb-3 pt-1 [overflow-wrap:anywhere]" data-testid="q-rule-detail">
      <dl className="grid gap-x-4 gap-y-1 text-xs md:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Description</dt><dd>{r.description}</dd>
        <dt className="text-muted-foreground">Justification</dt><dd>{r.justification}</dd>
        <dt className="text-muted-foreground">Scope</dt><dd>{r.scope.label}</dd>
        <dt className="text-muted-foreground">Matches</dt><dd><code>{JSON.stringify(r.match)}</code></dd>
        <dt className="text-muted-foreground">Does</dt><dd>{behaviourText(r.behaviour)}</dd>
        <dt className="text-muted-foreground">{r.temporary ? 'Ends' : 'Review by'}</dt><dd>{fmt(r.temporary ? r.expiresAt : r.reviewAt)}{r.temporary ? ' (temporary)' : ' (permanent until rolled back)'}</dd>
        <dt className="text-muted-foreground">Risk</dt><dd>{r.risk}{r.riskReasons.length ? ` — ${r.riskReasons.join(', ').replace(/_/g, ' ')}` : ''}{r.risk === 'high' ? ': two different people must approve it' : ''}</dd>
        <dt className="text-muted-foreground">Created</dt><dd>{r.createdBy} · {fmt(r.createdAt)} · revision {r.revision}</dd>
        <dt className="text-muted-foreground">Approved</dt><dd>{r.approvedBy ?? '—'}{r.secondApprovedBy ? `, then ${r.secondApprovedBy}` : ''}</dd>
        <dt className="text-muted-foreground">Matches so far</dt><dd>{r.matchCount}{r.lastMatchedAt ? ` (last ${fmt(r.lastMatchedAt)})` : ''} · shadow {r.shadowMatchCount}{r.dangerousMatchCount ? ` · ${r.dangerousMatchCount} known failures suppressed` : ''}</dd>
        {r.closedNote && <><dt className="text-muted-foreground">Note</dt><dd>{r.closedNote}</dd></>}
      </dl>
      {sim0 ? <SimView s={sim0} /> : r.status === 'pending' && <p className="text-xs text-muted-foreground">Not tested yet. A rule is approved only after a test against stored history.</p>}
      {manage && (
        <div className="flex flex-wrap gap-2" data-testid="q-rule-actions">
          {r.status === 'pending' && <Button size="sm" variant="outline" disabled={sim.isPending} onClick={() => sim.mutate()}><FlaskConical className="mr-1 h-4 w-4" />{sim.isPending ? 'Testing…' : 'Test proposed rule'}</Button>}
          {r.status === 'pending' && (!r.awaitingSecondApproval || r.mayApproveSecond) && <Button size="sm" disabled={!sim0?.current} onClick={() => { setAccept(false); setConfirm(true); }} data-testid="q-approve"><ShieldCheck className="mr-1 h-4 w-4" />{r.awaitingSecondApproval ? 'Approve (second)' : 'Approve'}</Button>}
          {r.status === 'pending' && <Button size="sm" variant="outline" onClick={() => onRevise({ draft: draftOf(), editId: r.id, revision: r.revision })}>Edit scope</Button>}
          {r.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => setClosing('reject')}><XCircle className="mr-1 h-4 w-4" />Reject</Button>}
          {r.status === 'active' && <Button size="sm" variant="outline" onClick={() => onRevise({ draft: { ...draftOf(), supersedesId: r.id } })}>Revise</Button>}
          {r.status === 'active' && <Button size="sm" variant="destructive" onClick={() => setClosing('rollback')} data-testid="q-rollback"><RotateCcw className="mr-1 h-4 w-4" />Roll back now</Button>}
        </div>
      )}
      {r.awaitingSecondApproval && !r.mayApproveSecond && <p className="text-xs text-muted-foreground">You gave the first approval. A second, different person must approve it.</p>}
      {closing && (
        <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" placeholder={closing === 'reject' ? 'Why reject it (at least 3 characters)' : 'Why roll it back (at least 3 characters)'} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" variant="destructive" disabled={note.trim().length < 3 || close.isPending} onClick={() => close.mutate()}>{closing === 'reject' ? 'Reject' : 'Roll back'}</Button><Button size="sm" variant="ghost" onClick={() => setClosing(null)}>Cancel</Button></div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {r.versions && r.versions.length > 0 && <p className="text-xs">Versions: {r.versions.map((v) => <span key={v.id} className="mr-2">{v.relation === 'previous' ? 'replaces' : 'replaced by'} “{v.name}” ({v.status.replace('_', ' ')})</span>)}</p>}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">History</div>
        <ol className="space-y-0.5 text-xs" data-testid="q-rule-history">{(r.history ?? []).map((h) => <li key={h.id}><span className="text-muted-foreground">{fmt(h.at)}</span> — {h.type.replace(/_/g, ' ')}{h.by ? ` by ${h.by}` : ''}{h.revision ? ` (revision ${h.revision})` : ''}{typeof h.detail?.note === 'string' ? `: “${h.detail.note}”` : ''}</li>)}</ol>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent data-testid="q-approve-dialog">
          <DialogHeader>
            <DialogTitle>Approve “{r.name}”?</DialogTitle>
            <DialogDescription>
              From now on, {behaviourText(r.behaviour).toLowerCase()} for {r.monitor} in {r.scope.label}. Open alerts it covers are re-checked now. You can roll it back at any time.
              {r.risk === 'high' && !r.awaitingSecondApproval ? ' This is a high-risk rule: it will wait for a second, different approver.' : ''}
            </DialogDescription>
          </DialogHeader>
          {!!sim0?.dangerous.length && (
            <label className="flex items-start gap-2 text-sm text-destructive"><input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} data-testid="q-accept-dangerous" />
              I have read the {sim0.dangerous.length} dangerous match{sim0.dangerous.length === 1 ? '' : 'es'} and accept that matching events will be {r.behaviour.kind === 'suppress' ? 'suppressed' : 'changed'}.</label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button disabled={appr.isPending || (!!sim0?.dangerous.length && !accept)} onClick={() => appr.mutate()} data-testid="q-approve-confirm">{`Approve${reauthSuffix(ask)}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function scopeInput(r: Rule): QualityScope {
  const k = r.scope.kind as QualityScope['kind'];
  if (k === 'endpoint') return { kind: k, endpointId: r.scope.endpointId ?? undefined };
  if (k === 'group') return { kind: k, groupId: r.scope.groupId ?? undefined };
  if (k === 'monitor') return { kind: k, monitorRuleId: r.scope.monitorRuleId ?? undefined };
  if (k === 'os') return { kind: k, osFamily: r.scope.osFamily ?? undefined, ...(r.scope.businessId ? { businessId: r.scope.businessId } : {}) };
  if (k === 'business') return { kind: k, businessId: r.scope.businessId ?? undefined };
  return { kind: 'platform' };
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function RuleEditor({ init, isPlatformAdmin, businessId, onClose, onSaved }: { init: { draft: Partial<QualityDraft>; editId?: string; revision?: number }; isPlatformAdmin: boolean; businessId: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const d0 = init.draft;
  const [name, setName] = useState(d0.name ?? '');
  const [description, setDescription] = useState(d0.description ?? '');
  const [justification, setJustification] = useState(d0.justification ?? '');
  const [scope, setScope] = useState<QualityScope>(d0.scope ?? (businessId ? { kind: 'business', businessId } : { kind: 'endpoint' }));
  const [match, setMatch] = useState<QualityDraft['match']>(d0.match ?? { ruleKey: '' });
  const [beh, setBeh] = useState<QualityBehaviour>(d0.behaviour ?? { kind: 'suppress' });
  const [temporary, setTemporary] = useState(!!d0.temporary);
  const [until, setUntil] = useState((d0.temporary ? d0.expiresAt : d0.reviewAt)?.slice(0, 10) ?? inDays(d0.temporary ? 30 : 180));
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const when = new Date(`${until}T23:59:00`).toISOString();
      const body: QualityDraft = {
        name: name.trim(), description: description.trim(), justification: justification.trim(), scope, match: clean(match), behaviour: beh, temporary,
        ...(temporary ? { expiresAt: when } : { reviewAt: when }),
        ...(!init.editId && d0.recommendationId ? { recommendationId: d0.recommendationId } : {}), ...(!init.editId && d0.supersedesId ? { supersedesId: d0.supersedesId } : {}),
      };
      if (init.editId) {
        const { recommendationId: _r, supersedesId: _s, ...rest } = body;
        return (await qualityApi.edit(init.editId, { ...rest, revision: init.revision! })).data.data as Rule;
      }
      return (await qualityApi.create(body)).data.data as Rule;
    },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['q-rules'] }); qc.invalidateQueries({ queryKey: ['q-recs'] }); qc.invalidateQueries({ queryKey: ['q-rule', r.id] }); onSaved(r.id); },
    onError: (e) => setErr(apiError(e).message),
  });
  const setM = (k: keyof QualityDraft['match'], v: string) => setMatch((m) => {
    const n: Record<string, unknown> = { ...m };
    if (!v.trim()) delete n[k];
    else if (k === 'eventId') n[k] = Number(v);
    else if (k === 'levels') n[k] = v.split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x));
    else n[k] = v.trim();
    return n as QualityDraft['match'];
  });
  const scopeKinds: QualityScope['kind'][] = ['endpoint', 'group', 'business', 'monitor', 'os', ...(isPlatformAdmin ? ['platform' as const] : [])];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="q-editor">
        <DialogHeader>
          <DialogTitle>{init.editId ? 'Edit proposed rule' : d0.supersedesId ? 'Revise rule' : 'Propose an alert quality rule'}</DialogTitle>
          <DialogDescription>A proposal changes nothing. It is tested against stored history and approved before it applies{d0.supersedesId ? ', and then replaces the rule it revises' : ''}. To turn a monitor off, use Settings → Monitoring.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="space-y-1"><Label htmlFor="qe-name">Name</Label><Input id="qe-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="qe-desc">Description</Label><Textarea id="qe-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="qe-just">Justification</Label><Textarea id="qe-just" rows={2} maxLength={1000} value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Why this is safe: the vendor issue, the ticket, what was checked" /></div>
          <fieldset className="grid gap-2 rounded-md border p-2 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium">Scope</legend>
            <select aria-label="Scope" className="rounded-md border bg-background p-2" value={scope.kind} onChange={(e) => { const k = e.target.value as QualityScope['kind']; setScope(k === 'business' && businessId ? { kind: k, businessId } : { kind: k }); }}>
              {scopeKinds.map((k) => <option key={k} value={k}>{({ endpoint: 'One computer', group: 'A device group', business: 'A business', monitor: 'One monitor', os: 'An operating system', platform: 'Every business (platform)' })[k]}</option>)}
            </select>
            {scope.kind === 'endpoint' && <Input aria-label="Computer id" placeholder="Computer id" value={scope.endpointId ?? ''} onChange={(e) => setScope({ ...scope, endpointId: e.target.value.trim() })} />}
            {scope.kind === 'group' && <Input aria-label="Group id" placeholder="Group id" value={scope.groupId ?? ''} onChange={(e) => setScope({ ...scope, groupId: e.target.value.trim() })} />}
            {scope.kind === 'business' && <Input aria-label="Business id" placeholder="Business id" value={scope.businessId ?? ''} onChange={(e) => setScope({ ...scope, businessId: e.target.value.trim() })} />}
            {scope.kind === 'monitor' && <Input aria-label="Monitor id" placeholder="Monitor id (from Settings → Monitoring)" value={scope.monitorRuleId ?? ''} onChange={(e) => setScope({ ...scope, monitorRuleId: e.target.value.trim() })} />}
            {scope.kind === 'os' && (
              <select aria-label="Operating system" className="rounded-md border bg-background p-2" value={scope.osFamily ?? ''} onChange={(e) => setScope({ ...scope, osFamily: e.target.value, ...(isPlatformAdmin ? {} : { businessId: businessId ?? undefined }) })}>
                <option value="">Choose…</option><option value="windows">Windows</option><option value="windows-client">Windows (client)</option><option value="windows-server">Windows Server</option><option value="linux">Linux</option><option value="macos">macOS</option>
              </select>
            )}
          </fieldset>
          <fieldset className="grid gap-2 rounded-md border p-2 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium">Which alerts (every condition must hold)</legend>
            <Input aria-label="Monitor key" placeholder="Monitor key, e.g. disk-errors" value={match.ruleKey} onChange={(e) => setMatch({ ...match, ruleKey: e.target.value.trim() })} />
            <Input aria-label="Event fingerprint" placeholder="Event fingerprint (32 hex)" value={match.fingerprint ?? ''} onChange={(e) => setM('fingerprint', e.target.value)} />
            <Input aria-label="Provider" placeholder="Provider" value={match.provider ?? ''} onChange={(e) => setM('provider', e.target.value)} />
            <Input aria-label="Event id" placeholder="Event id" inputMode="numeric" value={match.eventId ?? ''} onChange={(e) => setM('eventId', e.target.value)} />
            <Input aria-label="Levels" placeholder="Levels, e.g. 2,3" value={(match.levels ?? []).join(',')} onChange={(e) => setM('levels', e.target.value)} />
            <Input aria-label="Status code" placeholder="Status code 0x…" value={match.statusCode ?? ''} onChange={(e) => setM('statusCode', e.target.value)} />
            <p className="text-xs text-muted-foreground sm:col-span-2">An event-log rule must name the fingerprint, or both the provider and the event id. A threshold monitor (disk space, offline…) takes no event conditions.</p>
          </fieldset>
          <fieldset className="grid gap-2 rounded-md border p-2 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium">What it does</legend>
            <select aria-label="Behaviour" className="rounded-md border bg-background p-2" value={beh.kind} onChange={(e) => {
              const k = e.target.value; setBeh(k === 'downgrade' ? { kind: k, severity: 'WARNING' } : k === 'require_count' ? { kind: k, minCount: 3 } : k === 'require_repeats' ? { kind: k, reports: 3 } : { kind: 'suppress' });
            }}>
              <option value="suppress">Suppress (the event is still recorded)</option><option value="downgrade">Lower the severity</option><option value="require_count">Alert only at a count in one report</option><option value="require_repeats">Alert only after repeated reports</option>
            </select>
            {beh.kind === 'downgrade' && <select aria-label="Lower to" className="rounded-md border bg-background p-2" value={beh.severity} onChange={(e) => setBeh({ kind: 'downgrade', severity: e.target.value as 'WARNING' | 'INFO' })}><option value="WARNING">to warning</option><option value="INFO">to info</option></select>}
            {beh.kind === 'require_count' && <Input aria-label="Count" type="number" min={2} max={100} value={beh.minCount} onChange={(e) => setBeh({ kind: 'require_count', minCount: Number(e.target.value) })} />}
            {beh.kind === 'require_repeats' && <Input aria-label="Reports" type="number" min={2} max={100} value={beh.reports} onChange={(e) => setBeh({ kind: 'require_repeats', reports: Number(e.target.value) })} />}
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2"><input type="checkbox" checked={temporary} onChange={(e) => { setTemporary(e.target.checked); setUntil(inDays(e.target.checked ? 30 : 180)); }} />Temporary exception</label>
            <div className="space-y-1"><Label htmlFor="qe-until">{temporary ? 'Ends on (at most 90 days)' : 'Review by (at most a year)'}</Label><Input id="qe-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || name.trim().length < 3 || description.trim().length < 3 || justification.trim().length < 10 || !match.ruleKey} onClick={() => save.mutate()} data-testid="q-editor-save">{init.editId ? 'Save (a new revision)' : 'Propose'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function clean(m: QualityDraft['match']): QualityDraft['match'] {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out as QualityDraft['match'];
}
