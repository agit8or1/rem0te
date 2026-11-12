'use client';

import { useEffect, useState } from 'react';
import { CONNECTIVITY_DOT, CONNECTIVITY_TEXT, connectivityFrom, connectivityHint, connectivityLabel } from '@/lib/connectivity';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertOctagon, ArrowRight, Building2, CheckCircle2, Clock, Hourglass, MapPin, Monitor, PlayCircle,
  RotateCcw, ShieldCheck, Siren, Wrench, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientMap } from '@/components/dashboard/client-map';

/**
 * The technician dashboard (0.31).
 *
 * Built to answer, from stored data and in this order: what is broken, which
 * customers it affects, which devices need attention, what is already being
 * worked on, and what to do next. Everything comes from one call,
 * GET /dashboard/overview, which scopes every section server side; a section
 * the person has no permission for arrives as null and is not drawn — it is
 * never drawn as a zero.
 *
 * Nothing here is live in the sense of a socket: the page polls every 30 s and
 * says how old its data is, and every list item carries its own age, so a
 * stale figure always reads as stale.
 *
 * Server host health (CPU, memory, disk, relay) is not a fleet question and
 * moved to System status (/admin/status) for Platform Admins.
 */

type Biz = { id: string; name: string } | null;
type Dev = { id: string; name: string } | null;
interface QueueItem { key: string; kind: string; severity: 'critical' | 'warning' | 'info'; title: string; reason: string; business: Biz; device: Dev; since: string; href: string; rank: number }
interface Overview {
  generatedAt: string;
  scope: 'business' | 'platform';
  devices: null | { total: number; online: number; offline: number; agentSilent: number; reachable?: number; agentSilentAfterMinutes: number; offlineList: { id: string; name: string; business: Biz; lastSeenAt: string | null }[] };
  alerts: null | { open: number; acknowledged: number; critical: number; warning: number; info: number; criticalOpen: number; suppressed: number; outages: { id: string; title: string; state: string; suppressed: boolean; site: { id: string; name: string } | null; business: Biz; devices: number; since: string }[] };
  restart: null | { devices: number; list: { device: { id: string; name: string }; business: Biz; source: 'scan' | 'alert'; evidenceAt: string | null; stale: boolean }[] };
  patch: null | { definition: string; staleAfterHours: number; total: number; fresh: number; upToDate: number; needsUpdates: number; stale: number; noScan: number; newestScanAt: string | null; oldestFreshScanAt: string | null; compliancePercent: number | null; coveragePercent: number | null };
  actions: null | { awaitingApproval: number; failed: number; uncertain: number; inFlight: { id: string; title: string; status: string; targets: number; createdAt: string; dispatchedAt: string | null; business: Biz; device: Dev; href: string }[] };
  patchDeployments: null | { id: string; name: string; status: string; pausedReason: string | null; business: Biz; createdAt: string }[];
  sessions: null | { liveAfterHours: number; live: { id: string; status: string; connected: boolean; isAdHoc: boolean; startedAt: string; lastSignalAt: string | null; technician: string | null; device: Dev; business: Biz }[] };
  acknowledged: null | { id: string; title: string; severity: string; business: Biz; device: Dev; acknowledgedAt: string | null; by: string | null; href: string }[];
  customers: { business: { id: string; name: string }; critical: number; warning: number; outages: number; offline: number; failedActions: number }[];
  attention: { device: { id: string; name: string }; business: Biz; score: number; reasons: string[]; isOnline: boolean; lastSeenAt: string | null }[];
  recentDevices: null | { id: string; name: string; business: Biz; isOnline: boolean; lastSeenAt: string | null; lastSessionAt: string }[];
  activity: null | { id: string; action: string; label: string; at: string; actor: string | null; business: Biz; href: string | null }[];
  queue: { items: QueueItem[]; total: number };
}

function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Re-render on a timer so every "x ago" keeps telling the truth between polls. */
function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

const SEV_DOT: Record<string, string> = {
  critical: 'bg-red-500', warning: 'bg-amber-500', info: 'bg-sky-500',
};
const where = (b: Biz, d: Dev) => [b?.name, d?.name].filter(Boolean).join(' · ');

export default function DashboardPage() {
  const { isPlatformAdmin } = usePermissions();
  const now = useNow();
  // The device map is shown unless this viewer hid it (0.32: 0.31 hid it by
  // default and it read as removed). A per-browser convenience only.
  const [showMap, setShowMap] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem('dashboard.map') === 'hidden') setShowMap(false); } catch { /* storage unavailable */ }
  }, []);
  const toggleMap = () => setShowMap((v) => {
    try { localStorage.setItem('dashboard.map', v ? 'hidden' : 'shown'); } catch { /* storage unavailable */ }
    return !v;
  });

  const { data, isLoading, error, dataUpdatedAt } = useQuery<Overview>({
    queryKey: ['dashboard-overview'],
    queryFn: () => api.get('/dashboard/overview').then((r) => r.data?.data as Overview),
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="p-4 md:p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data) {
    return (
      <div className="p-4 md:p-6">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">The dashboard could not be loaded. Nothing below would be current, so nothing is shown.</p>
      </div>
    );
  }

  const d = data;
  const liveOutages = d.alerts?.outages.filter((o) => o.state === 'OPEN' && !o.suppressed) ?? [];
  const connected = d.sessions?.live.filter((s) => s.connected).length ?? 0;
  const launching = (d.sessions?.live.length ?? 0) - connected;
  const failedActions = d.actions ? d.actions.failed + d.actions.uncertain : 0;

  const mapOn = showMap && !!d.devices;
  const queueNote = d.queue.total > d.queue.items.length
    ? <span className="text-xs text-muted-foreground" title="The rest are on Alerts and the device pages">top {d.queue.items.length} of {d.queue.total}</span>
    : null;

  // 0.35 layout. From `lg` up the page is exactly the space under the top bar
  // (h-12) and, while one is showing, the containment banner (0.36: its
  // height is --containment-banner-h, set by ContainmentBanner): a fixed
  // header, the figures, then a 12-column grid whose rows
  // share what is left (minmax(0, …fr), so a long list scrolls inside its own
  // card instead of growing the page). Below `lg` everything stacks and the
  // page scrolls, as it should on a phone. Placement is explicit so the DOM
  // order is also the reading order when stacked: what to do, which devices,
  // who is affected, what is in hand, patches, then the map and history.
  return (
    <div className="flex flex-col gap-3 p-4 md:p-6 lg:h-[calc(100dvh-3rem-var(--containment-banner-h,0px))] lg:min-h-[600px] lg:py-4" data-testid="dashboard">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-xs text-muted-foreground">
          {d.scope === 'business' ? 'This business' : 'Every business'} · data from {ago(new Date(dataUpdatedAt || Date.parse(d.generatedAt)).toISOString(), now)} · refreshes every 30 s
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {d.devices && (
            <button type="button" onClick={toggleMap} className="inline-flex items-center gap-1 hover:text-foreground" data-testid="dashboard-map-toggle">
              <MapPin className="h-3.5 w-3.5" /> {showMap ? 'Hide device locations' : 'Show device locations'}
            </button>
          )}
          {isPlatformAdmin && (
            <Link href="/admin/status" className="inline-flex items-center gap-1 hover:text-foreground" title="Server health (CPU, memory, disk, relay) is on System status">
              Server health <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>

      {/* What is broken, at the scale of a whole site: first, and loud. Capped
          only on the fitted desktop layout (0.36): on a phone the page scrolls,
          and a capped strip cut the sentence and hid "Open alerts". */}
      {liveOutages.length > 0 && (
        <div className="shrink-0 rounded-lg border border-red-300 lg:max-h-24 lg:overflow-y-auto bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40" role="alert" data-testid="dashboard-outages">
          {liveOutages.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-x-2">
              <AlertOctagon className="h-4 w-4 text-red-600 dark:text-red-400" />
              <span className="font-medium">Site outage: {o.site?.name ?? 'a site'}{o.business ? ` (${o.business.name})` : ''}</span>
              <span className="text-muted-foreground">{o.devices} device{o.devices === 1 ? '' : 's'} stopped reporting together, since {ago(o.since, now)}</span>
              <Link href="/alerts" className="ml-auto text-xs underline underline-offset-2">Open alerts</Link>
            </div>
          ))}
        </div>
      )}

      {/* The figures, each one a way in: devices, alerts, restarts and patches, then what is waiting on people. */}
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7" data-testid="dashboard-tiles">
        {d.devices && (
          <Tile href="/endpoints" icon={Monitor} label="Devices" value={d.devices.total}
            // 0.35: online counts agents checking in; reachable-but-silent is said apart, never folded into it.
            sub={`${d.devices.online} online${d.devices.agentSilent ? ` · ${d.devices.agentSilent} agent silent` : ''} · ${d.devices.offline} offline`}
            tone={d.devices.offline || d.devices.agentSilent ? 'warn' : undefined}
            title={d.devices.agentSilent ? `${d.devices.agentSilent} reachable through RustDesk, but their agent has not checked in for ${d.devices.agentSilentAfterMinutes}+ minutes: remote control should work; monitoring, patching and actions are not reporting.` : undefined} />
        )}
        {d.alerts && (
          <Tile href="/alerts?state=open&severity=critical" icon={Siren} label="Critical alerts" value={d.alerts.criticalOpen}
            sub={`${d.alerts.open} open · ${d.alerts.acknowledged} acknowledged`} tone={d.alerts.criticalOpen ? 'bad' : undefined}
            title={d.alerts.suppressed ? `${d.alerts.suppressed} more are in a maintenance window and not counted as critical` : undefined} />
        )}
        {d.restart && (
          <Tile href="/patching" icon={RotateCcw} label="Restart pending" value={d.restart.devices}
            sub={d.restart.list.some((r) => r.stale) ? 'some from stale scans' : 'from scans and alerts'} tone={d.restart.devices ? 'warn' : undefined} />
        )}
        {d.patch && (
          <Tile href="/patching" icon={ShieldCheck} label="Patch compliance"
            value={d.patch.compliancePercent === null ? 'No data' : `${d.patch.compliancePercent}%`}
            sub={d.patch.compliancePercent === null ? `no scan under ${d.patch.staleAfterHours} h` : `${d.patch.fresh} of ${d.patch.total} devices scanned`}
            title={d.patch.definition} />
        )}
        {d.actions && (
          <Tile href="#work-next" icon={XCircle} label="Failed actions" value={failedActions}
            sub={d.actions.uncertain ? `${d.actions.uncertain} outcome unknown · 7 days` : 'last 7 days'} tone={failedActions ? 'bad' : undefined} />
        )}
        {d.actions && (
          <Tile href="#work-next" icon={Hourglass} label="Awaiting approval" value={d.actions.awaitingApproval}
            sub="approved on the signer, not here" />
        )}
        {d.sessions && (
          <Tile href="/sessions" icon={PlayCircle} label="Active sessions" value={connected}
            sub={launching ? `${launching} launching` : 'connected now'} />
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-12 lg:grid-rows-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]" data-testid="dashboard-grid">
        {/* What to do next, ranked, each with its reason. */}
        <Panel id="work-next" testId="dashboard-queue" title="Work on next" action={queueNote}
          className={`lg:col-span-5 lg:col-start-1 lg:row-start-1 ${mapOn ? 'lg:row-span-1' : 'lg:row-span-3'}`}>
          {d.queue.items.length === 0 ? (
            <Empty icon={CheckCircle2}>
              Nothing needs you right now{d.alerts ? '' : ' (alerts are not visible to you, so they are not part of this)'}.
            </Empty>
          ) : (
            <ol className="divide-y">
              {d.queue.items.map((i) => (
                <li key={i.key}>
                  <Link href={i.href} className="flex gap-3 py-2 hover:bg-muted/40 rounded-sm px-1 -mx-1">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV_DOT[i.severity]}`} aria-label={i.severity} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium">{i.title}</span>
                        <span className="text-xs text-muted-foreground">{where(i.business, i.device)}</span>
                      </span>
                      <span className="block text-xs text-muted-foreground">{i.reason}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{ago(i.since, now)}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        {/* Which devices. */}
        {d.devices && (
          <Panel testId="dashboard-attention" title="Devices needing attention" className="lg:col-span-4 lg:col-start-6 lg:row-start-1">
            {d.attention.length === 0 ? (
              <Empty icon={CheckCircle2}>Every device you can see is online, reporting, and has no open alert or failed action.</Empty>
            ) : (
              <ul className="divide-y">
                {d.attention.map((a) => (
                  <li key={a.device.id}>
                    <Link href={`/endpoints/${a.device.id}`} className="block py-2 hover:bg-muted/40 rounded-sm px-1 -mx-1">
                      <span className="flex items-baseline gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${CONNECTIVITY_DOT[connectivityFrom(a, now)]}`} aria-label={connectivityLabel(connectivityFrom(a, now), a.lastSeenAt, now)} />
                        <span className="text-sm font-medium truncate">{a.device.name}</span>
                        {a.business && <span className="text-xs text-muted-foreground truncate">{a.business.name}</span>}
                      </span>
                      <span className="block pl-4 text-xs text-muted-foreground">{a.reasons.join(' · ')}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {/* Who is affected. */}
        <Panel testId="dashboard-customers" title="Customers affected" className="lg:col-span-3 lg:col-start-10 lg:row-start-1">
          {d.customers.length === 0 ? (
            <Empty icon={Building2}>No business has an open alert, an offline device or a failed action that you can see.</Empty>
          ) : (
            <ul className="divide-y">
              {d.customers.slice(0, 10).map((c) => {
                const parts = [
                  c.outages && `${c.outages} outage${c.outages === 1 ? '' : 's'}`,
                  c.critical && `${c.critical} critical`,
                  c.failedActions && `${c.failedActions} failed action${c.failedActions === 1 ? '' : 's'}`,
                  c.warning && `${c.warning} warning`,
                  c.offline && `${c.offline} offline`,
                ].filter(Boolean);
                const body = (
                  <>
                    <span className="block text-sm font-medium truncate">{c.business.name}</span>
                    <span className={`block text-xs ${c.outages || c.critical ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>{parts.join(' · ')}</span>
                  </>
                );
                return (
                  <li key={c.business.id} className="py-2">
                    {isPlatformAdmin ? <Link href={`/businesses/${c.business.id}`} className="block hover:underline">{body}</Link> : body}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* What is already in hand. */}
        <Panel testId="dashboard-in-progress" title="Being worked on" className="lg:col-span-4 lg:col-start-6 lg:row-start-2">
          <InProgress d={d} now={now} />
        </Panel>

        {d.patch && (
          <Panel testId="dashboard-patch" title="Patch status" className="lg:col-span-3 lg:col-start-10 lg:row-start-2"
            action={<Link href="/patching" className="text-xs text-muted-foreground hover:underline">Patching</Link>}>
            <PatchBreakdown p={d.patch} now={now} />
          </Panel>
        )}

        {mapOn && (
          <div className="h-[360px] lg:col-span-5 lg:col-start-1 lg:row-span-2 lg:row-start-2 lg:h-auto lg:min-h-0" data-testid="dashboard-map">
            <ClientMap embedded />
          </div>
        )}

        {d.activity && (
          <Panel testId="dashboard-activity" title="Recent activity" className="lg:col-span-4 lg:col-start-6 lg:row-start-3"
            action={<Link href="/audit" className="text-xs text-muted-foreground hover:underline">Audit log</Link>}>
            {d.activity.length === 0 ? (
              <Empty icon={Activity}>No alert, action, patch, session or device activity in the last 7 days.</Empty>
            ) : (
              <ul className="divide-y">
                {d.activity.map((a) => {
                  const line = (
                    <span className="flex items-baseline gap-2 py-1.5">
                      <span className="min-w-0 flex-1 text-xs">
                        <span className="font-medium">{a.actor ?? 'System'}</span> {a.label}
                        {a.business && <span className="text-muted-foreground"> · {a.business.name}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{ago(a.at, now)}</span>
                    </span>
                  );
                  return <li key={a.id}>{a.href ? <Link href={a.href} className="block hover:bg-muted/40 rounded-sm px-1 -mx-1">{line}</Link> : <span className="block px-1 -mx-1">{line}</span>}</li>;
                })}
              </ul>
            )}
          </Panel>
        )}

        {d.recentDevices && (
          <Panel testId="dashboard-recent-devices" title="Your recent devices" className="lg:col-span-3 lg:col-start-10 lg:row-start-3">
            {d.recentDevices.length === 0 ? (
              <Empty icon={Clock}>You have not opened a session to a device you can still see.</Empty>
            ) : (
              <ul className="divide-y">
                {d.recentDevices.map((r) => (
                  <li key={r.id}>
                    <Link href={`/endpoints/${r.id}`} className="flex items-baseline gap-2 py-2 hover:bg-muted/40 rounded-sm px-1 -mx-1">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${CONNECTIVITY_DOT[connectivityFrom(r, now)]}`} aria-label={connectivityLabel(connectivityFrom(r, now), r.lastSeenAt, now)} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm truncate">{r.name}</span>
                        <span className="block text-xs text-muted-foreground truncate">{r.business?.name ? `${r.business.name} · ` : ''}your session {ago(r.lastSessionAt, now)}</span>
                      </span>
                      <span className={`shrink-0 text-[11px] ${connectivityFrom(r, now) === 'agent_silent' ? CONNECTIVITY_TEXT.agent_silent : 'text-muted-foreground'}`} title={connectivityHint(connectivityFrom(r, now))}>{connectivityFrom(r, now) === 'online' ? 'online' : connectivityFrom(r, now) === 'agent_silent' ? `agent silent ${ago(r.lastSeenAt, now)}` : `seen ${ago(r.lastSeenAt, now)}`}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * One dashboard card: the same header (title, and a link or note on the
 * right) and the same padding everywhere. From `lg` its body scrolls inside
 * the card, so the grid cell, not the list, decides the height.
 */
function Panel({ title, action, className, testId, id, children }: {
  title: string; action?: React.ReactNode; className?: string; testId: string; id?: string; children: React.ReactNode;
}) {
  return (
    <Card id={id} data-testid={testId} className={`flex flex-col lg:min-h-0 lg:overflow-hidden ${className ?? ''}`}>
      <CardHeader className="shrink-0 flex-row items-baseline justify-between gap-2 space-y-0 px-4 py-2.5">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" data-panel-body>
        {children}
      </CardContent>
    </Card>
  );
}

function InProgress({ d, now }: { d: Overview; now: number }) {
  const rows: { key: string; icon: React.ComponentType<{ className?: string }>; text: string; sub: string; href: string }[] = [];
  for (const s of d.sessions?.live ?? []) {
    rows.push({
      key: `s:${s.id}`, icon: PlayCircle,
      text: `${s.technician ?? 'Someone'} ${s.connected ? 'connected to' : 'launching'} ${s.device?.name ?? (s.isAdHoc ? 'a Quick Connect computer' : 'a computer')}`,
      sub: `${s.business?.name ? `${s.business.name} · ` : ''}last signal ${ago(s.lastSignalAt, now)}`, href: '/sessions',
    });
  }
  for (const a of d.acknowledged ?? []) {
    rows.push({ key: `a:${a.id}`, icon: Siren, text: a.title, sub: `${a.by ? `${a.by} acknowledged` : 'Acknowledged'} ${ago(a.acknowledgedAt, now)}${a.business ? ` · ${a.business.name}` : ''}`, href: a.href });
  }
  for (const j of d.actions?.inFlight ?? []) {
    rows.push({ key: `j:${j.id}`, icon: Wrench, text: `${j.title}${j.device ? ` on ${j.device.name}` : ` on ${j.targets} computers`}`, sub: `${j.status === 'DISPATCHED' ? `sent ${ago(j.dispatchedAt, now)}` : 'approved, not yet sent'}${j.business ? ` · ${j.business.name}` : ''}`, href: j.href });
  }
  for (const p of d.patchDeployments ?? []) {
    rows.push({ key: `p:${p.id}`, icon: ShieldCheck, text: `Patch deployment: ${p.name}`, sub: `${p.status === 'PAUSED' ? `paused${p.pausedReason ? `: ${p.pausedReason}` : ''}` : 'in progress'}${p.business ? ` · ${p.business.name}` : ''}`, href: `/patching/${p.id}` });
  }
  if (rows.length === 0) {
    return <Empty icon={Wrench}>No live session, acknowledged alert, action in flight or patch deployment in progress.</Empty>;
  }
  return (
    <ul className="divide-y">
      {rows.slice(0, 10).map((r) => (
        <li key={r.key}>
          <Link href={r.href} className="flex gap-2 py-2 hover:bg-muted/40 rounded-sm px-1 -mx-1">
            <r.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm truncate">{r.text}</span>
              <span className="block text-xs text-muted-foreground truncate">{r.sub}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PatchBreakdown({ p, now }: { p: NonNullable<Overview['patch']>; now: number }) {
  if (p.total === 0) return <Empty icon={ShieldCheck}>No devices.</Empty>;
  const seg = [
    { n: p.upToDate, label: 'up to date', cls: 'bg-green-500' },
    { n: p.needsUpdates, label: 'updates pending', cls: 'bg-amber-500' },
    { n: p.stale, label: `scan older than ${p.staleAfterHours} h`, cls: 'bg-muted-foreground/40' },
    { n: p.noScan, label: 'never scanned', cls: 'bg-slate-300 dark:bg-slate-600' },
  ];
  // The percentage itself is the Patch compliance tile's; this is what it is made of.
  return (
    <div className="space-y-2 text-xs">
      {p.compliancePercent === null && (
        <p className="text-muted-foreground">No device has an update scan from the last {p.staleAfterHours} hours, so compliance cannot be computed honestly.</p>
      )}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {seg.map((s) => s.n > 0 && <div key={s.label} className={s.cls} style={{ width: `${(s.n / p.total) * 100}%` }} />)}
      </div>
      <ul className="space-y-0.5">
        {seg.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.cls}`} />
            <span className="flex-1">{s.label}</span>
            <span className="tabular-nums">{s.n}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        Coverage {p.coveragePercent ?? 0}% ({p.fresh} of {p.total}). Newest scan {ago(p.newestScanAt, now)}{p.oldestFreshScanAt ? `, oldest counted ${ago(p.oldestFreshScanAt, now)}` : ''}.
      </p>
      <p className="text-muted-foreground">{p.definition}</p>
    </div>
  );
}

function Empty({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 py-2 text-xs text-muted-foreground">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** One figure, one line of context, one link. Colour only when the figure is bad. */
function Tile({
  label, value, sub, icon: Icon, href, tone, title,
}: {
  label: string; value: number | string; sub: string; icon: React.ComponentType<{ className?: string }>;
  href: string; tone?: 'bad' | 'warn'; title?: string;
}) {
  const border = tone === 'bad' ? 'border-l-4 border-l-red-500' : tone === 'warn' ? 'border-l-4 border-l-amber-500' : '';
  return (
    <Link href={href} className="block h-full" title={title}>
      <Card className={`h-full transition-colors hover:bg-muted/40 ${border}`}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </div>
          <div className="text-xl font-bold leading-tight tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</div>
          <p className="text-[11px] leading-snug text-muted-foreground line-clamp-2">{sub}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
