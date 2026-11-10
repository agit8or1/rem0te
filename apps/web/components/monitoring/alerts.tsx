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

/** Alert rows, badges and the expandable detail — shared by /alerts and the computer page (0.29). */

export type AlertRow = {
  id: string; kind: string; monitor: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; state: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string; detail: Record<string, unknown> | null;
  business: { id: string; name: string } | null; site: { id: string; name: string } | null; computer: { id: string; name: string | null; hostname?: string | null } | null;
  firstSeenAt: string; lastSeenAt: string; occurrences: number; notifyFrom: string; escalationLevel: number; lastNotifiedAt: string | null;
  suppressed: boolean; parentId: string | null; acknowledgedAt: string | null; resolvedAt: string | null; resolvedBy: 'person' | 'monitor' | null; resolveNote: string | null;
  ticket: { id: string; url: string | null; peer: string | null; linkedAt: string } | null;
};
type Detail = AlertRow & { events: { type: string; actorId: string | null; detail: Record<string, unknown> | null; at: string }[]; children: AlertRow[] };
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
const EVENT_LABEL: Record<string, string> = {
  raised: 'Raised', acknowledged: 'Acknowledged', resolved: 'Resolved', notified: 'Notified', escalated: 'Escalated',
  suppressed: 'Held by a maintenance window', unsuppressed: 'Maintenance window over', grouped: 'Grouped into a site outage',
  ticket_linked: 'Ticket linked', ticket_event: 'Sent to ClientSt0r',
};

/** What the monitor recorded, as label/value pairs. A nested sample (an event) shows its fields inline. */
function DetailList({ detail }: { detail: Record<string, unknown> }) {
  const label = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const show = (v: unknown): string => (v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== '').map(([k, x]) => `${label(k)}: ${String(x)}`).join(' · ') : String(v));
  return (
    <dl className="grid gap-x-4 gap-y-1 rounded-md border bg-background p-2 text-xs md:grid-cols-[max-content_1fr]">
      {Object.entries(detail).map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-muted-foreground">{label(k)}</dt><dd className="break-words">{show(v)}</dd></div>
      ))}
    </dl>
  );
}

export function AlertDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const { data } = useQuery<Detail>({ queryKey: ['alert', id], queryFn: () => monitoringApi.alert(id).then((r) => r.data.data) });
  const done = () => { setNote(''); setErr(null); qc.invalidateQueries({ queryKey: ['alert', id] }); onChanged(); };
  const ack = useMutation({ mutationFn: () => monitoringApi.acknowledge(id, note.trim() || undefined), onSuccess: done, onError: (e) => setErr(apiError(e).message) });
  const res = useMutation({ mutationFn: () => monitoringApi.resolve(id, note.trim()), onSuccess: done, onError: (e) => setErr(apiError(e).message) });
  if (!data) return <p className="px-3 pb-3 text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-3 bg-muted/30 px-3 pb-3 pt-1" data-testid="alert-detail">
      <div className="grid gap-2 md:grid-cols-3">
        <div><div className="text-xs text-muted-foreground">First seen</div>{fmt(data.firstSeenAt)}</div>
        <div><div className="text-xs text-muted-foreground">Monitor</div><code className="text-xs">{data.monitor}</code></div>
        <div><div className="text-xs text-muted-foreground">Notified</div>{data.lastNotifiedAt ? `level ${data.escalationLevel} · ${fmt(data.lastNotifiedAt)}` : data.suppressed ? `held until ${fmt(data.notifyFrom)}` : 'not yet'}</div>
        {data.computer && <div><div className="text-xs text-muted-foreground">Computer</div><Link className="text-primary hover:underline" href={`/endpoints/${data.computer.id}?tab=monitoring`}>{data.computer.name ?? data.computer.hostname ?? data.computer.id}</Link></div>}
        {data.ticket && (
          <div><div className="text-xs text-muted-foreground">Ticket</div>
            {data.ticket.url ? <a className="inline-flex items-center text-primary hover:underline" href={data.ticket.url} target="_blank" rel="noopener noreferrer">{data.ticket.id}<ExternalLink className="ml-1 h-3 w-3" /></a> : data.ticket.id}
          </div>
        )}
        {data.resolveNote && <div className="md:col-span-3"><div className="text-xs text-muted-foreground">Resolution</div>{data.resolveNote}</div>}
      </div>
      {data.detail && Object.keys(data.detail).length > 0 && <DetailList detail={data.detail} />}
      {data.children.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Computers in this outage ({data.children.length})</div>
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
              {Array.isArray(e.detail?.results) && <> → {(e.detail.results as { label: string; ok: boolean; status: string }[]).map((r) => `${r.label} ${r.ok ? '✓' : `✗ ${r.status}`}`).join(', ') || 'no destination for this severity'}</>}
            </li>
          ))}
        </ol>
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
