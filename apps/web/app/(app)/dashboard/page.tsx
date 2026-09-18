'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardApi, adminApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Monitor, Building2, Activity, WifiOff, Clock, ArrowDownUp, Radio,
} from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/lib/auth';
import { MeterGauge, Sparkline, rate, size } from '@/components/common/gauge';
import { ClientMap } from '@/components/dashboard/client-map';
import Link from 'next/link';

/**
 * The operator's landing view, built to fit one screen without scrolling.
 *
 * That constraint is the whole design. The previous layout ran eight tall stat
 * cards over two rows, then a map, then two full-height panels, then an
 * activity list — about two and a half screens, so the map and everything
 * under it were only ever seen by someone who scrolled. Nothing was removed to
 * fix it; the density changed. Tiles are one line of figures instead of three,
 * and the lower half is a fixed-height row whose panels scroll internally
 * rather than growing the page.
 *
 * `lg:h-screen lg:overflow-hidden` on the page, with the lower row as the only
 * flex-grow child, is what makes it end at the fold. Both are deliberately
 * `lg:`-only: on a phone a fixed-height row of stacked panels is unreadable,
 * and vertical scrolling is the right answer there.
 */
export default function DashboardPage() {
  const { isPlatformAdmin } = usePermissions();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => dashboardApi.stats().then((r) => r.data?.data),
    refetchInterval: 30_000,
  });

  /**
   * Host health, Platform Admin only.
   *
   * This is the platform operator's own server — its CPU, memory, disk and
   * link. A Business Owner has no business seeing how full the disk on shared
   * infrastructure is, which is why /admin/status is admin-gated and why this
   * query is disabled rather than merely hidden: not requesting it is the
   * difference between hiding a tile and not fetching the data.
   *
   * Polled faster than the rest of the page because it is the part that
   * actually moves second to second.
   */
  const { data: host } = useQuery({
    queryKey: ['admin-status'],
    queryFn: () => adminApi.status().then((r) => r.data?.data as HostStatus | undefined),
    enabled: isPlatformAdmin,
    refetchInterval: 5_000,
  });

  const onlinePercent = data?.endpoints?.onlinePercent ?? 0;
  const offlineCount = data?.endpoints?.offline ?? 0;
  const net = host?.network;

  return (
    <div className="p-4 lg:p-6 space-y-3 lg:h-screen lg:overflow-hidden flex flex-col">
      <div className="flex items-baseline justify-between gap-4 shrink-0">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-xs text-muted-foreground">
          {data?.scope === 'business' ? 'Your business' : 'Every business'} · refreshes automatically
        </p>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : (
        <>
          {/* Estate, on one row. "Launched" was removed deliberately: it counted
              sessions Rem0te had opened and not closed, which reads as a live
              figure and is not one — "In use now" is the tile that means that. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 shrink-0">
            <Tile href="/endpoints" label="Computers" value={data?.endpoints?.total ?? 0}
              sub={`${data?.endpoints?.online ?? 0} online`} icon={Monitor}
              accent={offlineCount > 0 ? 'yellow' : 'green'} />
            <Tile href="/endpoints" label="Offline" value={offlineCount}
              sub={`${onlinePercent}% up`} icon={WifiOff}
              accent={offlineCount > 0 ? 'red' : 'green'} />
            {/* Sessions actually moving traffic through this server's relay.
                Admin-only, because it is a property of the platform host. */}
            {isPlatformAdmin && (
              <Tile label="In use now" value={host?.relay?.sessions ?? 0}
                sub="relayed both ways" icon={Radio}
                accent={host?.relay?.sessions ? 'green' : undefined}
                title={
                  'Sessions currently relaying traffic through this server, counted from ' +
                  'paired connections on the relay port. RustDesk prefers a direct ' +
                  'peer-to-peer connection, and a session that went direct does not pass ' +
                  'through here — so this counts relayed sessions, not every session.'
                } />
            )}
            <Tile href="/sessions" label="Sessions 7d" value={data?.sessions?.last7Days ?? 0}
              sub="last week" icon={Clock} />
            <Tile href="/sessions" label="Sessions 30d" value={data?.sessions?.last30Days ?? 0}
              sub="last month" icon={Activity} />
            {!isPlatformAdmin && (
              <Tile href="/businesses" label="Businesses" value={data?.businesses?.total ?? 0}
                sub="active" icon={Building2} />
            )}
          </div>

          {/* Host health. One card of gauges rather than four tiles, because
              they are read together — "is this server coping" is one question. */}
          {isPlatformAdmin && (
            <Card className="shrink-0">
              <CardContent className="py-3">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
                  <MeterGauge
                    label="CPU"
                    percent={host?.cpu?.percent ?? null}
                    detail={
                      host?.cpu
                        ? `${host.cpu.count} cores · load ${host.cpu.loadAvg.map((l) => l.toFixed(2)).join(' / ')}`
                        : undefined
                    }
                    unknown="sampling…"
                  />
                  <MeterGauge
                    label="Memory"
                    percent={host?.memory?.percent ?? null}
                    detail={host?.memory ? `${size(host.memory.used)} of ${size(host.memory.total)}` : undefined}
                    unknown="sampling…"
                  />
                  <MeterGauge
                    label="Disk"
                    percent={host?.disk?.percent ?? null}
                    detail={host?.disk ? `${size(host.disk.free)} free of ${size(host.disk.total)}` : undefined}
                    unknown="sampling…"
                  />
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <ArrowDownUp className="h-3 w-3" /> Bandwidth
                      </span>
                      <span className="text-sm font-semibold tabular-nums">
                        {rate(net?.rxBytesPerSec)}
                      </span>
                    </div>
                    <Sparkline values={(net?.history ?? []).map((h) => h.rx + h.tx)} height={22} />
                    <div className="text-[11px] text-muted-foreground tabular-nums">
                      ↓ {rate(net?.rxBytesPerSec)} · ↑ {rate(net?.txBytesPerSec)}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* The lower half: map, recent sessions, seven-day shape. Bounded on
              desktop so the page ends at the fold; each panel scrolls itself. */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 lg:flex-1 lg:min-h-0">
            {/* Carries its own header and its located / unlocatable counts, so
                it is placed directly rather than wrapped in a second card. */}
            <div className="lg:col-span-2 lg:min-h-0">
              <ClientMap embedded />
            </div>

            <div className="flex flex-col gap-3 lg:min-h-0">
              <Card className="flex flex-col lg:flex-1 lg:min-h-0 overflow-hidden">
                <CardHeader className="py-2 shrink-0">
                  <CardTitle className="text-sm">Recent sessions</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 overflow-y-auto">
                  {data?.sessions?.recent?.length ? (
                    <div className="divide-y">
                      {(data.sessions.recent as Record<string, unknown>[]).slice(0, 6).map((s) => (
                        <div key={s.id as string} className="py-1.5">
                          <p className="text-xs font-medium truncate">
                            {(s.endpoint as { name?: string } | null)?.name ??
                              (s.adHocRustdeskId as string) ?? 'Ad-hoc'}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {(s.technician as { email?: string } | null)?.email} ·{' '}
                            {formatDate(s.createdAt as string)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No sessions yet.</p>
                  )}
                </CardContent>
              </Card>

              <Card className="shrink-0">
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">Sessions — last 7 days</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 pb-3">
                  <SessionsByDay rows={(data?.activity?.sessionsByDay ?? []) as DayCount[]} />
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface DayCount { date: string; count: number }

/**
 * `YYYY-MM-DD` as a date in the viewer's own timezone.
 *
 * `new Date('2026-09-11')` is parsed as **UTC midnight**, so in any
 * negative-offset browser it formats as the 10th — every label on this chart
 * was one day early, and being single letters (`weekday: 'narrow'` gives S, S,
 * M, T, W, T) there was nothing to notice it by. Building the date from its
 * parts keeps it local and keeps the label matching the bar.
 */
function localDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * Seven days of session counts.
 *
 * The server zero-fills the series, so this renders exactly what it is given
 * and never closes a gap: a quiet day is a labelled column with no bar, not a
 * missing column. A zero is drawn as no bar at all rather than a minimum-height
 * stub — the old `Math.max(4, …)` floor made an idle day look like a small
 * amount of work.
 */
function SessionsByDay({ rows }: { rows: DayCount[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No session data yet.</p>;
  }

  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="space-y-1">
      {/* `items-stretch` and `h-full` on the column are load-bearing, not
          decoration. With `items-end` on this row each column sizes to its own
          content, so the track's `flex-1` has no free space to claim, collapses
          to zero height, and the bar's `height: N%` resolves to a percentage of
          nothing. The counts and the day labels still render, which is what
          made it look like a data problem for so long: a chart with correct
          numbers and no bars at all. */}
      <div className="flex items-stretch gap-1 h-20">
        {rows.map((row) => {
          const day = localDay(row.date);
          return (
            <div key={row.date} className="flex-1 h-full flex flex-col items-center gap-1 min-w-0">
              <span className="text-[10px] tabular-nums text-muted-foreground leading-none">
                {row.count > 0 ? row.count : ''}
              </span>
              <div className="w-full flex-1 min-h-0 bg-muted rounded-sm flex items-end overflow-hidden">
                <div
                  className="w-full bg-primary rounded-sm transition-all"
                  style={{ height: `${(row.count / max) * 100}%` }}
                />
              </div>
              <span
                className="text-[10px] text-muted-foreground"
                title={day.toLocaleDateString(undefined, { dateStyle: 'full' })}
              >
                {day.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
            </div>
          );
        })}
      </div>
      {total === 0 && (
        <p className="text-[11px] text-muted-foreground">No sessions in the last 7 days.</p>
      )}
    </div>
  );
}

interface HostStatus {
  memory?: { total: number; used: number; free: number; percent: number };
  cpu?: { count: number; loadAvg: [number, number, number]; percent?: number };
  disk?: { total: number; used: number; free: number; percent: number };
  network?: {
    rxBytesPerSec: number; txBytesPerSec: number;
    history: { rx: number; tx: number; cpu: number }[];
    sampleSeconds: number;
  };
  relay?: { port: number; connections: number; sessions: number };
}

type Accent = 'green' | 'red' | 'yellow' | 'blue';

/**
 * One figure, one line of context, one row tall.
 *
 * Deliberately not the old StatCard, which spent a padded header, a 2xl
 * numeral and a sub-line on each of eight tiles — over half the viewport
 * before anything else was drawn.
 */
function Tile({
  label, value, sub, icon: Icon, accent, href, title,
}: {
  label: string;
  value: number;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: Accent;
  href?: string;
  title?: string;
}) {
  const accents: Record<Accent, string> = {
    green: 'border-l-green-500',
    red: 'border-l-red-500',
    yellow: 'border-l-yellow-500',
    blue: 'border-l-blue-500',
  };
  const body = (
    <Card
      title={title}
      className={`h-full transition-colors ${href ? 'hover:bg-muted/40 cursor-pointer' : ''}${
        accent ? ` border-l-4 ${accents[accent]}` : ''
      }`}
    >
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground truncate">{label}</span>
          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </div>
        <div className="text-xl font-bold leading-tight tabular-nums">{value.toLocaleString()}</div>
        <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}
