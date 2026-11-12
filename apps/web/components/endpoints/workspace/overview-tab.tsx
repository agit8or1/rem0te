'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { notesApi } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SeverityBadge, StateBadge } from '@/components/monitoring/alerts';
import { EndpointSpecs, Row } from '@/components/endpoints/endpoint-specs';
import { PatchSummaryCard, type Patches } from '@/components/endpoints/endpoint-patches';
import { SESSION_STATUS_LABEL } from '@/components/sessions/session-status-badge';
import { formatDate } from '@/lib/utils';
import { ago, CHANGE_LABEL, openAlerts, type WorkspaceTab } from './device-model';
import type { MonitoringView } from './use-device-data';
import { personName, type SessionRow } from './history-tab';

/**
 * The Overview summarises without sending anyone elsewhere: assignment, key
 * alerts, patch health and recent activity on top, then the hardware,
 * utilisation and network cards the agent reported, each with its own age.
 * Every summary links to the tab with the rest of it.
 */

function OpenTab({ tab, label, onOpen }: { tab: WorkspaceTab; label: string; onOpen: (t: WorkspaceTab) => void }) {
  return (
    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpen(tab)}>
      {label}<ArrowRight className="h-3 w-3 ml-1" />
    </Button>
  );
}

function SummaryCard({ title, aside, children, testId }: { title: string; aside?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {aside}
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">{children}</CardContent>
    </Card>
  );
}

type Activity = { at: string; kind: string; text: string; detail?: string };

export function DeviceOverviewTab({
  endpointId, ep, mon, patches, sessions, onOpenTab, showAlertsAndPatches, adminExtras, agentCard,
}: {
  endpointId: string;
  ep: Record<string, unknown>;
  mon: MonitoringView | undefined;
  patches: Patches | undefined;
  sessions: SessionRow[];
  onOpenTab: (t: WorkspaceTab) => void;
  showAlertsAndPatches: boolean;
  adminExtras?: React.ReactNode;
  /** The Agent card (0.34): type, version, update and upgrade. */
  agentCard?: React.ReactNode;
}) {
  const customer = ep.customer as { id: string; name: string } | null;
  const site = ep.site as { id: string; name: string } | null;
  const aliases = (ep.aliases as { id: string; alias: string }[]) ?? [];
  const tags = (ep.tags as { id: string; tag: string }[]) ?? [];
  // Static and rule groups (0.35), as the server evaluated them for this viewer.
  const groups = (ep.groups as { id: string; name: string; kind?: 'static' | 'rule' }[] | undefined) ?? [];
  const groupHref = (id: string) => `/endpoints?${new URLSearchParams({ ...(customer?.id ? { businessId: customer.id } : {}), groupId: id })}`;

  // Same key as the History tab's notes, so it is one request for both.
  const { data: notes } = useQuery({
    queryKey: ['notes', 'endpoint', endpointId],
    queryFn: () => notesApi.list({ endpointId }).then((r) => r.data?.data ?? []),
  });

  const open = openAlerts(mon?.alerts);
  const activity: Activity[] = [
    ...sessions.map((s) => ({ at: s.createdAt, kind: 'Session', text: `${personName(s.technician)} — ${(SESSION_STATUS_LABEL[s.status] ?? s.status).toLowerCase()}` })),
    ...(mon?.changes ?? []).map((c) => ({ at: c.detectedAt, kind: CHANGE_LABEL[c.category] ?? c.category, text: `${c.change} ${c.subject}` })),
    ...(Array.isArray(notes) ? (notes as Record<string, unknown>[]) : []).map((n) => ({
      at: n.createdAt as string, kind: 'Note', text: String(n.content ?? '').split('\n')[0].slice(0, 120),
    })),
  ].filter((a) => a.at).sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 6);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SummaryCard title="Assignment">
          <Row label="Business">{customer?.name ?? '—'}</Row>
          <Row label="Site">{site?.name ?? '—'}</Row>
          <Row label="Groups">
            <div className="flex flex-wrap gap-1 justify-end" data-testid="device-groups">
              {groups.length ? groups.map((g) => (
                <Link key={g.id} href={groupHref(g.id)} data-group-kind={g.kind ?? 'static'} className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={g.kind === 'rule' ? `Rule group: this computer matches its rule now. Opens the device list filtered by ${g.name}.` : `Opens the device list filtered by ${g.name}.`}>
                  <Badge variant={g.kind === 'rule' ? 'outline' : 'secondary'} className="text-xs hover:underline">{g.name}{g.kind === 'rule' ? ' · rule' : ''}</Badge>
                </Link>
              )) : '—'}
            </div>
          </Row>
          <Row label="Platform">{ep.platform ? <Badge variant="secondary">{ep.platform as string}</Badge> : '—'}</Row>
          <Row label="Tags">
            <div className="flex flex-wrap gap-1 justify-end">
              {tags.length ? tags.map((t) => <Badge key={t.id} variant="secondary" className="text-xs">{t.tag}</Badge>) : '—'}
            </div>
          </Row>
          <Row label="Aliases">
            <div className="flex flex-wrap gap-1 justify-end">
              {aliases.length ? aliases.map((a) => <Badge key={a.id} variant="outline" className="text-xs font-mono">{a.alias}</Badge>) : '—'}
            </div>
          </Row>
          <Row label="Enrolled">{formatDate(ep.createdAt as string)}</Row>
        </SummaryCard>

        {showAlertsAndPatches && (
          <SummaryCard title="Key alerts" testId="overview-alerts" aside={<OpenTab tab="monitoring" label="Monitoring" onOpen={onOpenTab} />}>
            {!mon ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : mon.alerts === null ? (
              <p className="text-muted-foreground">Seeing alerts needs the monitoring:alerts permission.</p>
            ) : open.length === 0 ? (
              <p className="text-muted-foreground">No open alerts.</p>
            ) : (
              <ul className="space-y-2">
                {open.slice(0, 4).map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <SeverityBadge s={a.severity} /><span className="font-medium">{a.title}</span><StateBadge a={a} />
                    <span className="ml-auto text-xs text-muted-foreground" title={formatDate(a.lastSeenAt)}>{ago(a.lastSeenAt)}</span>
                  </li>
                ))}
                {open.length > 4 && <li className="text-xs text-muted-foreground">and {open.length - 4} more on the Monitoring tab</li>}
              </ul>
            )}
          </SummaryCard>
        )}

        {showAlertsAndPatches && (
          <div className="space-y-2" data-testid="overview-patches">
            {patches ? <PatchSummaryCard s={patches.summary} platform={ep.platform} /> : (
              <SummaryCard title="Patch status"><p className="text-muted-foreground">Loading…</p></SummaryCard>
            )}
            <div className="flex justify-end"><OpenTab tab="patches" label="Updates offered and history on Patches" onOpen={onOpenTab} /></div>
          </div>
        )}

        {agentCard}

        <SummaryCard title="Recent activity" testId="overview-activity" aside={<OpenTab tab="history" label="History" onOpen={onOpenTab} />}>
          {activity.length === 0 ? (
            <p className="text-muted-foreground">Nothing recorded yet: no sessions, notes or inventory changes.</p>
          ) : (
            <ul className="space-y-1.5">
              {activity.map((a, i) => (
                <li key={`${a.at}-${i}`} className="flex gap-3 text-xs">
                  <span className="w-16 shrink-0 text-muted-foreground" title={formatDate(a.at)}>{ago(a.at)}</span>
                  <span className="w-16 shrink-0 font-medium">{a.kind}</span>
                  <span className="min-w-0 break-words">{a.text}</span>
                </li>
              ))}
            </ul>
          )}
        </SummaryCard>
      </div>

      <EndpointSpecs endpointId={endpointId} endpoint={ep} onOpenPatches={showAlertsAndPatches ? () => onOpenTab('patches') : undefined} />
      {adminExtras}
    </div>
  );
}
