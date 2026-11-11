'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Network, Settings2, Siren } from 'lucide-react';
import { monitoringApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { apiError } from '@/components/security-controls/shared';
import { AlertDetail, type AlertRow, SeverityBadge, StateBadge, type Summary } from '@/components/monitoring/alerts';

/**
 * Alerts (0.29).
 *
 * One row per problem, not per occurrence: a repeat of an open alert raises
 * its count. A site outage gathers the offline alerts behind it, and those
 * are not notified on their own while it is open. Acknowledging says
 * "someone has it" and stops escalation; resolving closes it with a note
 * (most alerts also resolve themselves when the monitor sees it clear).
 */

const STATES = ['active', 'open', 'acknowledged', 'resolved', 'all'];
const SEVERITIES = ['critical', 'warning', 'info'];

export default function AlertsPage() {
  const { user, can, isBusinessOwner } = usePermissions();
  const qc = useQueryClient();
  const [state, setStateRaw] = useState('active');
  const [severity, setSeverityRaw] = useState('');
  // The filters live in the URL too, so the dashboard's "Critical alerts" and
  // any shared link open the list already filtered. Unknown values are ignored.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const st = q.get('state'), sv = q.get('severity');
    if (st && STATES.includes(st)) setStateRaw(st);
    if (sv && SEVERITIES.includes(sv)) setSeverityRaw(sv);
  }, []);
  function syncUrl(st: string, sv: string) {
    const q = new URLSearchParams(window.location.search);
    if (st === 'active') q.delete('state'); else q.set('state', st);
    if (!sv) q.delete('severity'); else q.set('severity', sv);
    const qs = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }
  const setState = (v: string) => { setStateRaw(v); syncUrl(v, severity); };
  const setSeverity = (v: string) => { setSeverityRaw(v); syncUrl(state, v); };
  const [open, setOpen] = useState<string | null>(null);

  const { data: summary } = useQuery<Summary>({
    queryKey: ['alerts-summary'],
    queryFn: () => monitoringApi.summary().then((r) => r.data.data),
    enabled: !!user, refetchInterval: 30_000,
  });
  const { data, isLoading, error } = useQuery<{ alerts: AlertRow[]; next: string | null }>({
    queryKey: ['alerts', state, severity],
    queryFn: () => monitoringApi.alerts({ state, severity: severity || undefined, limit: 100 }).then((r) => r.data.data),
    enabled: !!user, refetchInterval: 30_000, retry: false,
  });

  if (!user) return null;
  const configure = isBusinessOwner || can('monitoring:configure' as never);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="Alerts"
        description="Problems the monitors found on your computers. Repeats are counted on one alert; a site outage gathers the offline computers behind it."
        actions={configure ? (
          <Button variant="outline" asChild><Link href="/settings/monitoring"><Settings2 className="mr-1 h-4 w-4" />Monitors and notifications</Link></Button>
        ) : undefined}
      />

      {summary?.visible && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="alerts-summary">
          {[
            ['Open', summary.open], ['Acknowledged', summary.acknowledged], ['Critical', summary.critical], ['Warning', summary.warning], ['In maintenance', summary.suppressed],
          ].map(([l, n]) => (
            <Card key={l as string}><CardContent className="pt-4"><div className="text-2xl font-semibold">{n as number}</div><div className="text-xs text-muted-foreground">{l as string}</div></CardContent></Card>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3" data-testid="alerts-filters">
        <div className="space-y-1">
          <Label htmlFor="al-state">Showing</Label>
          <select id="al-state" className="rounded-md border bg-background p-2 text-sm" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="active">Open and acknowledged</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">Everything</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="al-sev">Severity</Label>
          <select id="al-sev" className="rounded-md border bg-background p-2 text-sm" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">Any</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <Card data-testid="alerts-list">
        <CardContent className="p-0 text-sm">
          {isLoading && <p className="p-4 text-muted-foreground">Loading…</p>}
          {error && <p className="p-4 text-muted-foreground">{apiError(error).message}</p>}
          {data && data.alerts.length === 0 && (
            <p className="flex items-center gap-2 p-4 text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Nothing here.{state === 'active' ? ' No monitor has anything open.' : ''}</p>
          )}
          {data?.alerts.map((a) => (
            <div key={a.id} className="border-b last:border-b-0">
              <button type="button" className="flex w-full flex-wrap items-center gap-2 p-3 text-left hover:bg-accent/50" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                {a.kind === 'SITE_OUTAGE' ? <Network className="h-4 w-4 text-red-600" /> : <Siren className="h-4 w-4 text-muted-foreground" />}
                <SeverityBadge s={a.severity} />
                <span className="font-medium">{a.title}</span>
                <StateBadge a={a} />
                {a.occurrences > 1 && <Badge variant="outline">×{a.occurrences}</Badge>}
                {a.parentId && <Badge variant="outline">in site outage</Badge>}
                {a.ticket && <Badge variant="outline">ticket {a.ticket.id}</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {a.business?.name}{a.computer ? ` · ${a.computer.name ?? a.computer.hostname ?? ''}` : a.site ? ` · ${a.site.name}` : ''} · {fmt(a.lastSeenAt)}
                </span>
              </button>
              {open === a.id && <AlertDetail id={a.id} onChanged={() => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['alerts-summary'] }); }} />}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
