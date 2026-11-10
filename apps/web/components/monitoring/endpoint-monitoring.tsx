'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { monitoringApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { apiError } from '@/components/security-controls/shared';
import { AlertDetail, type AlertRow, SeverityBadge, StateBadge } from './alerts';

/** One computer's monitoring (0.29): what it runs, what it reported, its alerts, change history and software. */

type View = {
  scopes: string[];
  rules: { key: string; kind: string; name: string; severity: string; params: Record<string, unknown>; inheritedFrom: string; overrides: string[]; id: string }[];
  report: { services?: { name: string; status: string; startType: string | null }[]; events?: { key: string; checkedAt: string; count: number; newestAt: string | null; sample: { eventId: number | null; message: string | null } | null }[] } | null;
  reportedAt: string | null;
  alerts: AlertRow[] | null;
  changes: { id: string; category: string; change: string; subject: string; before: string | null; after: string | null; detectedAt: string }[];
  software: { name: string; version: string | null; publisher: string | null; installedOn: string | null }[] | null;
  softwareCount: number | null; inventoryAt: string | null;
};

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
const from = (k: string) => (k === 'global' ? 'global' : ({ b: 'business', s: 'site', e: 'this computer' } as Record<string, string>)[k[0]] ?? k);

export function EndpointMonitoring({ endpointId }: { endpointId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const { data, error } = useQuery<View>({ queryKey: ['mon-endpoint', endpointId], queryFn: () => monitoringApi.endpoint(endpointId).then((r) => r.data.data), retry: false });
  if (error) return <p className="text-sm text-muted-foreground">{apiError(error).message}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const sw = (data.software ?? []).filter((s) => !filter || `${s.name} ${s.publisher ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4" data-testid="endpoint-monitoring">
      <Card>
        <CardHeader><CardTitle className="text-sm">Alerts</CardTitle></CardHeader>
        <CardContent className="p-0 text-sm">
          {data.alerts === null && <p className="p-4 text-muted-foreground">Seeing alerts needs the monitoring:alerts permission.</p>}
          {data.alerts?.length === 0 && <p className="p-4 text-muted-foreground">No alerts for this computer.</p>}
          {data.alerts?.map((a) => (
            <div key={a.id} className="border-b last:border-b-0">
              <button type="button" className="flex w-full flex-wrap items-center gap-2 p-3 text-left hover:bg-accent/50" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <SeverityBadge s={a.severity} /><span className="font-medium">{a.title}</span><StateBadge a={a} />
                <span className="ml-auto text-xs text-muted-foreground">{fmt(a.lastSeenAt)}</span>
              </button>
              {open === a.id && <AlertDetail id={a.id} onChanged={() => qc.invalidateQueries({ queryKey: ['mon-endpoint', endpointId] })} />}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card data-testid="mon-effect">
        <CardHeader><CardTitle className="text-sm">Monitors in effect</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {data.rules.length === 0 && <p className="text-muted-foreground">No monitors apply. Set them in Settings → Monitoring.</p>}
          {data.rules.map((r) => (
            <div key={r.key} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name}</span><code className="text-xs text-muted-foreground">{r.key}</code>
              <Badge variant="secondary">{r.severity.toLowerCase()}</Badge>
              <span className="text-xs text-muted-foreground">from {from(r.inheritedFrom)}{r.overrides?.length ? `, replacing ${r.overrides.map(from).join(', ')}` : ''}</span>
            </div>
          ))}
          {data.report && (
            <div className="mt-3 space-y-1 border-t pt-3">
              <div className="text-xs text-muted-foreground">Last report from the agent: {fmt(data.reportedAt)}</div>
              {data.report.services?.map((s) => (
                <div key={s.name} className="flex items-center gap-2"><code className="text-xs">{s.name}</code>
                  <Badge variant={s.status === 'Running' ? 'secondary' : 'destructive'}>{s.status}</Badge>{s.startType && <span className="text-xs text-muted-foreground">{s.startType}</span>}
                </div>
              ))}
              {data.report.events?.map((e) => (
                <div key={e.key} className="text-xs"><code>{e.key}</code>: {e.count} matching{e.sample?.eventId != null ? ` · last ID ${e.sample.eventId}` : ''}{e.newestAt ? ` at ${fmt(e.newestAt)}` : ''}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="mon-changes">
        <CardHeader><CardTitle className="text-sm">Changes</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {data.changes.length === 0 && <p className="text-muted-foreground">No changes recorded. The first inventory is the baseline; later ones are compared with it.</p>}
          {data.changes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground"><tr><th className="py-1 pr-3">When</th><th className="pr-3">What</th><th className="pr-3">Item</th><th className="pr-3">Before</th><th>After</th></tr></thead>
                <tbody>
                  {data.changes.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="py-1 pr-3 whitespace-nowrap">{fmt(c.detectedAt)}</td>
                      <td className="pr-3"><Badge variant="outline">{c.category} {c.change}</Badge></td>
                      <td className="pr-3">{c.subject}</td><td className="pr-3 text-muted-foreground">{c.before ?? ''}</td><td>{c.after ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="mon-software">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Installed software{data.softwareCount != null ? ` (${data.softwareCount})` : ''}</CardTitle>
          {data.software && <Input className="h-8 w-56" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        </CardHeader>
        <CardContent className="text-sm">
          {!data.software && <p className="text-muted-foreground">Not reported yet — the agent sends it with its next inventory (0.29 agents and later).</p>}
          {data.software && (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="py-1 pr-3">Name</th><th className="pr-3">Version</th><th className="pr-3">Publisher</th><th>Installed</th></tr></thead>
                <tbody>
                  {sw.map((s, i) => (
                    <tr key={`${s.name}-${i}`} className="border-t"><td className="py-1 pr-3">{s.name}</td><td className="pr-3">{s.version ?? ''}</td><td className="pr-3">{s.publisher ?? ''}</td><td>{s.installedOn ? new Date(s.installedOn).toLocaleDateString() : ''}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">As of {fmt(data.inventoryAt)}.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
