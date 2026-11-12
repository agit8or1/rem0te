'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiError } from '@/components/security-controls/shared';
import { AlertDetail, type AlertRow, SeverityBadge, StateBadge } from '@/components/monitoring/alerts';
import { formatDate } from '@/lib/utils';
import { ago, CHANGE_LABEL, describeMonitor, MONITOR_KIND_LABEL, monitorSource, openAlerts } from './device-model';
import { useMonitoringView } from './use-device-data';

/**
 * One computer's monitoring: its alerts first, then what is watched and what
 * the agent last reported, then what changed. Rule keys and kinds are shown in
 * words; the key stays available as a tooltip for whoever edits the rule.
 */

function AlertList({ rows, endpointId }: { rows: AlertRow[]; endpointId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {rows.map((a) => (
        <div key={a.id} className="border-b last:border-b-0">
          <button type="button" className="flex w-full flex-wrap items-center gap-2 p-3 text-left hover:bg-accent/50" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
            <SeverityBadge s={a.severity} /><span className="font-medium">{a.title}</span><StateBadge a={a} />
            {a.occurrences > 1 && <span className="text-xs text-muted-foreground">{a.occurrences} times</span>}
            <span className="ml-auto text-xs text-muted-foreground" title={formatDate(a.lastSeenAt)}>last seen {ago(a.lastSeenAt)}</span>
          </button>
          {open === a.id && <AlertDetail id={a.id} onChanged={() => qc.invalidateQueries({ queryKey: ['mon-endpoint', endpointId] })} />}
        </div>
      ))}
    </>
  );
}

export function DeviceMonitoringTab({ endpointId }: { endpointId: string }) {
  const [showResolved, setShowResolved] = useState(false);
  const { data, error } = useMonitoringView(endpointId);
  if (error) return <p className="text-sm text-muted-foreground">{apiError(error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const active = openAlerts(data.alerts);
  const resolved = (data.alerts ?? []).filter((a) => a.state === 'RESOLVED');
  const ruleByKey = new Map(data.rules.map((r) => [r.key, r]));
  const serviceRule = (name: string) => data.rules.find((r) => r.kind === 'SERVICE_STOPPED' && String(r.params.service).toLowerCase() === name.toLowerCase());

  return (
    <div className="space-y-4" data-testid="endpoint-monitoring">
      <Card data-testid="mon-alerts">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Alerts{data.alerts ? ` · ${active.length} open` : ''}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 text-sm">
          {data.alerts === null && <p className="px-4 pb-4 text-muted-foreground">Seeing alerts needs the monitoring:alerts permission.</p>}
          {data.alerts && active.length === 0 && <p className="px-4 pb-4 text-muted-foreground">No open alerts for this computer.</p>}
          {active.length > 0 && <div className="border-t"><AlertList rows={active} endpointId={endpointId} /></div>}
          {resolved.length > 0 && (
            <div className="border-t">
              <button type="button" className="flex w-full items-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowResolved((s) => !s)} aria-expanded={showResolved}>
                {showResolved ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
              </button>
              {showResolved && <div className="border-t"><AlertList rows={resolved} endpointId={endpointId} /></div>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="mon-effect">
        <CardHeader className="pb-3"><CardTitle className="text-sm">What is watched on this computer</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {data.rules.length === 0 && <p className="text-muted-foreground">No monitors apply. Set them in <Link className="underline" href="/settings/monitoring">Settings › Monitoring</Link>.</p>}
          {data.rules.length > 0 && (
            <ul className="divide-y rounded-md border">
              {data.rules.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <span className="font-medium" title={`Rule key: ${r.key}`}>{r.name}</span>
                  <Badge variant="outline" className="text-[10px]">{MONITOR_KIND_LABEL[r.kind] ?? r.kind}</Badge>
                  <span className="text-xs text-muted-foreground">{describeMonitor(r.kind, r.params)}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{r.severity.toLowerCase()}</span>
                    <span data-testid="mon-source">· {monitorSource(r, data.scopeNames)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.report ? (
            <div className="space-y-1.5 pt-2">
              <p className="text-xs text-muted-foreground" title={data.reportedAt ? formatDate(data.reportedAt) : undefined}>
                Last report from the agent: {ago(data.reportedAt)}
              </p>
              {data.report.services?.map((s) => {
                const rule = serviceRule(s.name);
                return (
                  <div key={s.name} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{rule?.name ?? 'Service'}</span>
                    <code className="text-muted-foreground">{s.name}</code>
                    <Badge variant={s.status === 'Running' ? 'secondary' : 'destructive'} className="text-[10px]">{s.status.toLowerCase()}</Badge>
                    {s.startType && <span className="text-muted-foreground">starts {s.startType.toLowerCase()}</span>}
                  </div>
                );
              })}
              {data.report.events?.map((e) => {
                const rule = ruleByKey.get(e.key);
                return (
                  <div key={e.key} className="text-xs">
                    <span className="font-medium" title={`Rule key: ${e.key}`}>{rule?.name ?? e.key}</span>
                    {': '}{e.count === 0 ? 'no matching events' : `${e.count} matching event${e.count === 1 ? '' : 's'}`}
                    {e.sample?.eventId != null ? ` · latest ID ${e.sample.eventId}` : ''}
                    {e.newestAt ? ` ${ago(e.newestAt)}` : ''}
                    <span className="text-muted-foreground"> · checked {ago(e.checkedAt)}</span>
                  </div>
                );
              })}
            </div>
          ) : data.rules.some((r) => r.kind === 'SERVICE_STOPPED' || r.kind === 'EVENT_MATCH') ? (
            <p className="text-xs text-muted-foreground pt-1">The agent has not reported its service and event checks yet. They arrive with its heartbeat.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card data-testid="mon-changes">
        <CardHeader className="pb-3"><CardTitle className="text-sm">What changed on this computer</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {data.changes.length === 0 && <p className="text-muted-foreground">No changes recorded. The first inventory is the baseline; later ones are compared with it.</p>}
          {data.changes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground"><tr><th className="py-1 pr-3 font-medium">When</th><th className="pr-3 font-medium">What</th><th className="pr-3 font-medium">Item</th><th className="pr-3 font-medium">Before</th><th className="font-medium">After</th></tr></thead>
                <tbody>
                  {data.changes.map((c) => (
                    <tr key={c.id} className="border-t align-top">
                      <td className="py-1 pr-3 whitespace-nowrap" title={formatDate(c.detectedAt)}>{ago(c.detectedAt)}</td>
                      <td className="py-1 pr-3 whitespace-nowrap"><Badge variant="outline" className="text-[10px]">{CHANGE_LABEL[c.category] ?? c.category} {c.change}</Badge></td>
                      <td className="py-1 pr-3">{c.subject}</td><td className="py-1 pr-3 text-muted-foreground">{c.before ?? ''}</td><td className="py-1">{c.after ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
