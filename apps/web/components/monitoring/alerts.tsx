'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, ExternalLink } from 'lucide-react';
import { monitoringApi } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiError } from '@/components/security-controls/shared';
import { ReportFalsePositiveButton } from '@/components/monitoring/false-positive-dialog';
import { EntryActions } from '@/components/endpoints/ai-ticket-actions';

/** Alert rows, badges and the expandable detail — shared by /alerts and the computer page (0.29). */

export type AlertRow = {
  id: string; kind: string; monitor: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; state: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string; detail: Record<string, unknown> | null;
  business: { id: string; name: string } | null; site: { id: string; name: string } | null; computer: { id: string; name: string | null; hostname?: string | null } | null;
  firstSeenAt: string; lastSeenAt: string; occurrences: number; notifyFrom: string; escalationLevel: number; lastNotifiedAt: string | null;
  suppressed: boolean; parentId: string | null; acknowledgedAt: string | null; resolvedAt: string | null; resolvedBy: 'person' | 'monitor' | null; resolveNote: string | null;
  ticket: { id: string; url: string | null; peer: string | null; linkedAt: string } | null;
  /** 0.55: the automatic PSA ticket (Monitoring → Monitoring policies → Automatic tickets). */
  autoTicket?: { status: 'sending' | 'sent' | 'failed' | 'gave_up'; attempts: number; lastStatus: string | null; connectorKind: string | null; ref: string | null; url: string | null; lastAttemptAt: string; nextAttemptAt: string | null } | null;
  /** 0.66: the classifier's verdict (null on alerts raised before 0.66). */
  classification?: { class: AlertClass; basis: string; matched: string | null; version: number | null } | null;
  fingerprint?: string | null;
};
export type AlertClass = 'CRITICAL' | 'WARNING' | 'INFORMATIONAL' | 'BENIGN' | 'UNKNOWN';
type Explanation = {
  whatHappened: string; whyGenerated: string; howSerious: string; recommendedAction: string; certainty: string;
  classification: { class: AlertClass; basis: string; matched: string | null; matchedTitle: string | null; version: number; seen: number; unseen: number; benign: number };
};
type Detail = AlertRow & {
  events: { type: string; actorId: string | null; detail: Record<string, unknown> | null; at: string }[]; children: AlertRow[];
  explanation?: Explanation;
  rule?: { id: string; key: string; name: string; kind: string; severity: string; enabled: boolean; params: Record<string, unknown>; scope: string | null } | null;
  similar?: { total: number; recent: AlertRow[]; onThisComputer: { seen: number; firstSeenAt: string; lastSeenAt: string; class: string } | null };
  /** 0.67: the approved alert quality rules that changed it, and its false-positive reports. */
  qualityRules?: { id: string; name: string; status: string }[];
  falsePositive?: { reports: number; mine: { reason: string; createdAt: string } | null };
};
export type Summary = { visible: boolean; open: number; acknowledged: number; critical: number; warning: number; info: number; suppressed: number };

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
export function SeverityBadge({ s }: { s: AlertRow['severity'] }) {
  const cls = s === 'CRITICAL' ? 'bg-red-600 text-white hover:bg-red-600' : s === 'WARNING' ? 'bg-amber-500 text-black hover:bg-amber-500' : 'bg-sky-600 text-white hover:bg-sky-600';
  return <Badge className={cls}>{s.toLowerCase()}</Badge>;
}
export function StateBadge({ a }: { a: Pick<AlertRow, 'state' | 'suppressed' | 'resolvedBy'> }) {
  if (a.state === 'RESOLVED') return <Badge variant="outline">resolved{a.resolvedBy === 'monitor' ? ' (cleared)' : ''}</Badge>;
  return (
    <>
      <Badge variant={a.state === 'OPEN' ? 'destructive' : 'secondary'}>{a.state === 'OPEN' ? 'open' : 'acknowledged'}</Badge>
      {a.suppressed && <Badge variant="outline" className="ml-1"><BellOff className="mr-1 h-3 w-3" />maintenance</Badge>}
    </>
  );
}
/** 0.66: how the classifier judged an event alert, as a short badge with the reason in its tooltip. */
const CLASS_LABEL: Record<AlertClass, string> = { CRITICAL: 'known failure', WARNING: 'known warning', INFORMATIONAL: 'informational', BENIGN: 'known harmless', UNKNOWN: 'unverified' };
const BASIS_TIP: Record<string, string> = {
  known_benign: 'Matched a known harmless pattern on every condition.', known_event: 'A Windows event Rem0te recognises.',
  level: 'Windows logged it as Information.', rule: 'Rem0te does not recognise this event: the monitor\'s severity stands.',
  partial: 'The agent counted more events than it sent; the rest could not be checked.', threshold: 'The monitor\'s own threshold.',
  quality_rule: 'An approved alert quality rule for this scope changed it (Monitoring → False positives & rules).',
};
export function ClassBadge({ c }: { c: AlertRow['classification'] }) {
  if (!c || c.basis === 'threshold') return null;
  return <Badge variant="outline" title={BASIS_TIP[c.basis] ?? c.basis} data-testid="alert-class">{c.basis === 'partial' ? 'partly checked' : c.basis === 'quality_rule' ? 'changed by a rule' : CLASS_LABEL[c.class]}</Badge>;
}

const EVENT_LABEL: Record<string, string> = {
  raised: 'Raised', acknowledged: 'Acknowledged', resolved: 'Resolved', notified: 'Notified', escalated: 'Escalated',
  suppressed: 'Held by a maintenance window', unsuppressed: 'Maintenance window over', grouped: 'Grouped into a site outage',
  ticket_linked: 'Ticket linked', ticket_event: 'Sent to ClientSt0r',
  ticketed: 'Ticket opened in the PSA', ticket_failed: 'PSA ticket not sent',
  reclassified: 'Reclassified',
  false_positive_reported: 'Reported as a false positive',
};

/** 0.55: the automatic PSA ticket as a short badge — its reference (a link when the PSA gave one), or what went wrong. */
export function AutoTicketBadge({ t }: { t: AlertRow['autoTicket'] }) {
  if (!t) return null;
  if (t.status === 'sent') {
    const label = `ticket ${t.ref ?? '(no reference)'}`;
    return t.url
      ? <a href={t.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} data-testid="auto-ticket"><Badge variant="outline">{label}<ExternalLink className="ml-1 h-3 w-3" /></Badge></a>
      : <Badge variant="outline" data-testid="auto-ticket">{label}</Badge>;
  }
  if (t.status === 'sending') return <Badge variant="outline" data-testid="auto-ticket">ticket sending…</Badge>;
  return <Badge variant="outline" className="border-destructive/50 text-destructive" data-testid="auto-ticket" title={t.lastStatus ?? undefined}>{t.status === 'failed' ? 'ticket failed, will retry' : 'ticket not sent'}</Badge>;
}

/** What the monitor recorded, as label/value pairs. A nested sample (an event) shows its fields inline. */
function DetailList({ detail }: { detail: Record<string, unknown> }) {
  const label = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const show = (v: unknown): string => (v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== '').map(([k, x]) => `${label(k)}: ${String(x)}`).join(' · ') : String(v));
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 rounded-md border bg-background p-2 text-xs md:grid-cols-[max-content_minmax(0,1fr)]">
      {Object.entries(detail).filter(([k]) => k !== 'samples').map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-muted-foreground">{label(k)}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{show(v)}</dd></div>
      ))}
    </dl>
  );
}

/** 0.66: the plain-English explanation — what happened, why, how serious, what to do — and how sure Rem0te is. */
function ExplanationBox({ e }: { e: Explanation }) {
  const rows: [string, string][] = [
    ['What happened?', e.whatHappened], ['Why was this alert generated?', e.whyGenerated], ['How serious is it?', e.howSerious], ['Recommended action', e.recommendedAction],
  ];
  return (
    <div className="min-w-0 space-y-2 rounded-md border bg-background p-3 [overflow-wrap:anywhere]" data-testid="alert-explanation">
      {rows.map(([h, t]) => (
        <div key={h}><div className="text-xs font-medium text-foreground">{h}</div><p className="text-sm text-muted-foreground">{t}</p></div>
      ))}
      <div>
        <div className="text-xs font-medium text-foreground">Classification details</div>
        <p className="text-sm text-muted-foreground" data-testid="alert-classification">
          <span className="font-medium text-foreground">{CLASS_LABEL[e.classification.class]}</span>
          {e.classification.matchedTitle ? <> — {e.classification.matchedTitle}</> : null}
          {e.classification.matched ? <> (<code className="text-xs">{e.classification.matched}</code>)</> : null}. {e.certainty}
          {e.classification.version ? <> Classifier v{e.classification.version}.</> : <> Raised before alert classification (0.66).</>}
        </p>
      </div>
    </div>
  );
}

export function AlertDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [show, setShow] = useState<'raw' | 'similar' | 'rule' | null>(null);
  const toggle = (k: 'raw' | 'similar' | 'rule') => setShow(show === k ? null : k);
  const [err, setErr] = useState<string | null>(null);
  const { data, error } = useQuery<Detail>({ queryKey: ['alert', id], queryFn: () => monitoringApi.alert(id).then((r) => r.data.data), retry: false });
  const done = () => { setNote(''); setErr(null); qc.invalidateQueries({ queryKey: ['alert', id] }); onChanged(); };
  const ack = useMutation({ mutationFn: () => monitoringApi.acknowledge(id, note.trim() || undefined), onSuccess: done, onError: (e) => setErr(apiError(e).message) });
  const res = useMutation({ mutationFn: () => monitoringApi.resolve(id, note.trim()), onSuccess: done, onError: (e) => setErr(apiError(e).message) });
  if (error) return <p className="px-3 py-3 text-muted-foreground">{apiError(error).message === 'Alert not found' ? 'This alert was not found, or is not one you can see.' : apiError(error).message}</p>;
  if (!data) return <p className="px-3 pb-3 text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-3 bg-muted/30 px-3 pb-3 pt-1" data-testid="alert-detail">
      <div className="grid gap-2 md:grid-cols-3">
        <div><div className="text-xs text-muted-foreground">First seen</div>{fmt(data.firstSeenAt)}</div>
        <div><div className="text-xs text-muted-foreground">Monitor</div><code className="text-xs">{data.monitor}</code></div>
        <div><div className="text-xs text-muted-foreground">Notified</div>{data.lastNotifiedAt ? `level ${data.escalationLevel} · ${fmt(data.lastNotifiedAt)}` : data.suppressed ? `held until ${fmt(data.notifyFrom)}` : 'not yet'}</div>
        {data.computer && <div><div className="text-xs text-muted-foreground">Device</div><Link className="text-primary hover:underline" href={`/endpoints/${data.computer.id}?tab=monitoring`}>{data.computer.name ?? data.computer.hostname ?? data.computer.id}</Link></div>}
        {data.ticket && (
          <div><div className="text-xs text-muted-foreground">Ticket</div>
            {data.ticket.url ? <a className="inline-flex items-center text-primary hover:underline" href={data.ticket.url} target="_blank" rel="noopener noreferrer">{data.ticket.id}<ExternalLink className="ml-1 h-3 w-3" /></a> : data.ticket.id}
          </div>
        )}
        {data.autoTicket && (
          <div><div className="text-xs text-muted-foreground">PSA ticket (automatic)</div>
            {data.autoTicket.status === 'sent'
              ? (data.autoTicket.url
                ? <a className="inline-flex items-center text-primary hover:underline" href={data.autoTicket.url} target="_blank" rel="noopener noreferrer">{data.autoTicket.ref ?? 'open'}<ExternalLink className="ml-1 h-3 w-3" /></a>
                : (data.autoTicket.ref ?? 'sent (the PSA gave no reference)'))
              : data.autoTicket.status === 'failed'
                ? `not sent yet (${data.autoTicket.lastStatus ?? 'error'}); try ${data.autoTicket.attempts + 1} at ${fmt(data.autoTicket.nextAttemptAt)}`
                : data.autoTicket.status === 'sending' ? 'sending…' : `not sent (${data.autoTicket.lastStatus ?? 'gave up'}) after ${data.autoTicket.attempts} tr${data.autoTicket.attempts === 1 ? 'y' : 'ies'}`}
          </div>
        )}
        {data.resolveNote && <div className="md:col-span-3"><div className="text-xs text-muted-foreground">Resolution</div>{data.resolveNote}</div>}
      </div>
      {data.explanation && <ExplanationBox e={data.explanation} />}
      {!!data.qualityRules?.length && (
        <p className="text-xs text-muted-foreground" data-testid="alert-quality-rules">
          Changed by {data.qualityRules.map((q, i) => <span key={q.id}>{i ? ', ' : ''}<Link className="text-primary hover:underline" href={`/alerts/quality?rule=${q.id}`}>{q.name}</Link>{q.status !== 'active' ? ` (${q.status.replace('_', ' ')})` : ''}</span>)}.
        </p>
      )}
      {data.detail && Object.keys(data.detail).length > 0 && <DetailList detail={data.detail} />}
      <div className="flex flex-wrap gap-2" data-testid="alert-views">
        {data.detail && <Button size="sm" variant="ghost" aria-expanded={show === 'raw'} onClick={() => toggle('raw')}>View raw event</Button>}
        {data.similar && <Button size="sm" variant="ghost" aria-expanded={show === 'similar'} onClick={() => toggle('similar')}>View similar alerts{data.similar.total ? ` (${data.similar.total})` : ''}</Button>}
        {data.rule && <Button size="sm" variant="ghost" aria-expanded={show === 'rule'} onClick={() => toggle('rule')}>View matching monitor rule</Button>}
      </div>
      {show === 'raw' && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 text-xs [overflow-wrap:anywhere]" data-testid="alert-raw">{JSON.stringify(data.detail, null, 2)}</pre>
      )}
      {show === 'similar' && data.similar && (
        <div className="rounded-md border bg-background p-2 text-xs" data-testid="alert-similar">
          {data.similar.onThisComputer && <p className="mb-1 text-muted-foreground">This device has reported this event in {data.similar.onThisComputer.seen} report{data.similar.onThisComputer.seen === 1 ? '' : 's'} since {fmt(data.similar.onThisComputer.firstSeenAt)} (including any classified harmless).</p>}
          {!data.fingerprint && <p className="text-muted-foreground">Only event alerts carry an event fingerprint; there is nothing to compare this one with.</p>}
          {data.fingerprint && data.similar.total === 0 && <p className="text-muted-foreground">No other alert you can see has the same event fingerprint.</p>}
          <ul className="space-y-1">
            {data.similar.recent.map((s2) => (
              <li key={s2.id} className="flex flex-wrap items-center gap-2"><SeverityBadge s={s2.severity} /><StateBadge a={s2} /><span>{s2.computer?.name ?? s2.title}</span><span className="text-muted-foreground">{fmt(s2.lastSeenAt)}</span>{s2.resolveNote && <span className="text-muted-foreground">— {s2.resolveNote}</span>}</li>
            ))}
          </ul>
          {data.fingerprint && data.similar.total > data.similar.recent.length && <Link className="text-primary hover:underline" href={`/alerts?state=all&fingerprint=${data.fingerprint}`}>All {data.similar.total}</Link>}
        </div>
      )}
      {show === 'rule' && data.rule && (
        <div className="rounded-md border bg-background p-2 text-xs" data-testid="alert-rule">
          <p><span className="font-medium">{data.rule.name}</span> (<code>{data.rule.key}</code>) · {data.rule.kind} · {data.rule.severity.toLowerCase()} · {data.rule.scope ?? 'scope'}{data.rule.enabled ? '' : ' · disabled'}</p>
          <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(data.rule.params, null, 2)}</pre>
        </div>
      )}
      {data.children.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Devices in this outage ({data.children.length})</div>
          <ul className="space-y-1">
            {data.children.map((c) => <li key={c.id} className="flex items-center gap-2"><StateBadge a={c} /> {c.computer?.name ?? c.title}</li>)}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">History</div>
        <ol className="space-y-0.5 text-xs">
          {data.events.map((e, i) => (
            <li key={i}><span className="text-muted-foreground">{fmt(e.at)}</span> — {EVENT_LABEL[e.type] ?? e.type}
              {typeof e.detail?.note === 'string' && <>: “{e.detail.note}”</>}
              {e.type === 'ticketed' && typeof e.detail?.ref === 'string' && <>: {e.detail.ref}</>}
              {e.type === 'ticket_failed' && typeof e.detail?.status === 'string' && <>: {e.detail.status}{typeof e.detail?.retryAt === 'string' ? `, retry at ${fmt(e.detail.retryAt)}` : ', not retried'}</>}
              {e.type === 'false_positive_reported' && typeof e.detail?.reason === 'string' && <>: {String(e.detail.reason).replace(/_/g, ' ')}{e.detail.recommendPrevent ? ', recommending prevention' : ''}</>}
              {e.type === 'reclassified' && typeof e.detail?.from === 'string' && <>: {String(e.detail.from).toLowerCase()} → {e.detail.to ? String(e.detail.to).toLowerCase() : 'closed (harmless)'}{typeof e.detail.class === 'string' ? ` (${CLASS_LABEL[e.detail.class as AlertClass] ?? e.detail.class})` : ''}</>}
              {Array.isArray(e.detail?.results) && <> → {(e.detail.results as { label: string; ok: boolean; status: string }[]).map((r) => `${r.label} ${r.ok ? '✓' : `✗ ${r.status}`}`).join(', ') || 'no destination for this severity'}</>}
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="alert-quality-actions">
        {data.kind !== 'SITE_OUTAGE' && <ReportFalsePositiveButton alertId={id} onDone={done} />}
        {data.falsePositive && data.falsePositive.reports > 0 && <Badge variant="outline" data-testid="alert-fp-count">reported false positive ×{data.falsePositive.reports}</Badge>}
        {/* 0.67: advisory AI only, through the existing AI module (Administration → AI); it never decides. */}
        {data.computer && <EntryActions endpointId={data.computer.id} source={{ source: 'alert', alertId: id }} />}
      </div>
      {data.state !== 'RESOLVED' && (
        <div className="space-y-2">
          <Label htmlFor={`note-${id}`}>Note</Label>
          <Textarea id={`note-${id}`} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional to acknowledge; required to resolve" />
          <div className="flex flex-wrap gap-2">
            {data.state === 'OPEN' && <Button size="sm" variant="outline" disabled={ack.isPending} onClick={() => ack.mutate()}>Acknowledge</Button>}
            <Button size="sm" disabled={note.trim().length < 3 || res.isPending} onClick={() => res.mutate()}>Resolve</Button>
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
      )}
    </div>
  );
}
