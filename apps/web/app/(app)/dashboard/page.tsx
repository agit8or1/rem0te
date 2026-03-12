'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Monitor,
  PlayCircle,
  Building2,
  Activity,
  Users,
  WifiOff,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { formatDate } from '@/lib/utils';
import { SessionStatusBadge } from '@/components/sessions/session-status-badge';
import Link from 'next/link';

export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => dashboardApi.stats().then((r) => r.data?.data),
    refetchInterval: 30_000,
  });

  const onlinePercent = data?.endpoints?.onlinePercent ?? 0;
  const offlineCount = data?.endpoints?.offline ?? 0;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Dashboard" description="Overview of your environment" />

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : (
        <>
          {/* KPI Cards — Row 1 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Link href="/connect?tab=endpoints">
              <StatCard
                title="Total Endpoints"
                value={data?.endpoints?.total ?? 0}
                sub={`${data?.endpoints?.online ?? 0} online`}
                icon={<Monitor className="h-4 w-4 text-muted-foreground" />}
                accent={onlinePercent === 100 ? 'green' : offlineCount > 0 ? 'yellow' : undefined}
              />
            </Link>
            <Link href="/connect?tab=endpoints">
              <StatCard
                title="Offline Endpoints"
                value={offlineCount}
                sub={`${onlinePercent}% availability`}
                icon={<WifiOff className="h-4 w-4 text-muted-foreground" />}
                accent={offlineCount > 0 ? 'red' : 'green'}
              />
            </Link>
            <Link href="/sessions">
              <StatCard
                title="Active Sessions"
                value={data?.sessions?.active ?? 0}
                sub="right now"
                icon={<PlayCircle className="h-4 w-4 text-muted-foreground" />}
                accent={data?.sessions?.active ? 'blue' : undefined}
              />
            </Link>
            <Link href="/sessions">
              <StatCard
                title="Sessions (30d)"
                value={data?.sessions?.last30Days ?? 0}
                sub="last 30 days"
                icon={<Activity className="h-4 w-4 text-muted-foreground" />}
              />
            </Link>
          </div>

          {/* KPI Cards — Row 2 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Link href="/admin/access?tab=customers">
              <StatCard
                title="Customers"
                value={data?.customers?.total ?? 0}
                sub="active"
                icon={<Building2 className="h-4 w-4 text-muted-foreground" />}
              />
            </Link>
            <Link href="/admin/access?tab=technicians">
              <StatCard
                title="Users"
                value={data?.users?.total ?? 0}
                sub="active accounts"
                icon={<Users className="h-4 w-4 text-muted-foreground" />}
              />
            </Link>
            <Link href="/sessions">
              <StatCard
                title="Sessions (7d)"
                value={data?.sessions?.last7Days ?? 0}
                sub="last 7 days"
                icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              />
            </Link>
            <Link href="/sessions">
              <StatCard
                title="Pending Sessions"
                value={data?.sessions?.pending ?? 0}
                sub="awaiting action"
                icon={<AlertCircle className="h-4 w-4 text-muted-foreground" />}
                accent={(data?.sessions?.pending ?? 0) > 0 ? 'yellow' : undefined}
              />
            </Link>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Sessions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent Sessions</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.sessions?.recent?.length ? (
                  <div className="divide-y">
                    {data.sessions.recent.map((s: Record<string, unknown>) => (
                      <div key={s.id as string} className="py-3 flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium">
                            {(s.endpoint as { name?: string } | null)?.name ??
                              (s.adHocRustdeskId as string) ??
                              'Ad-hoc'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {(s.technician as { email?: string } | null)?.email} ·{' '}
                            {formatDate(s.createdAt as string)}
                          </p>
                        </div>
                        <SessionStatusBadge status={s.status as string} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No sessions yet.</p>
                )}
              </CardContent>
            </Card>

            {/* Sessions by day */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sessions — Last 7 Days</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.activity?.sessionsByDay?.length ? (
                  <div className="space-y-2">
                    {(data.activity.sessionsByDay as Array<{ date: string; count: number }>).map(
                      (row) => {
                        const max = Math.max(
                          1,
                          ...((data.activity.sessionsByDay as Array<{ count: number }>) ?? []).map(
                            (r) => r.count,
                          ),
                        );
                        const pct = Math.round((row.count / max) * 100);
                        return (
                          <div key={row.date} className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-20 shrink-0">
                              {new Date(row.date).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                              })}
                            </span>
                            <div className="flex-1 bg-muted rounded-full h-2">
                              <div
                                className="bg-primary rounded-full h-2 transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs font-medium w-6 text-right">{row.count}</span>
                          </div>
                        );
                      },
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No session data yet.</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          {data?.activity?.recent?.length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y">
                  {(data.activity.recent as Record<string, unknown>[]).slice(0, 8).map(
                    (log: Record<string, unknown>) => (
                      <div key={log.id as string} className="py-2.5 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <Badge variant="secondary" className="text-xs shrink-0">
                            {(log.action as string).replace(/_/g, ' ')}
                          </Badge>
                          <span className="text-xs text-muted-foreground truncate">
                            {(log.actor as { email?: string } | null)?.email ?? 'System'}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatDate(log.createdAt as string)}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

type Accent = 'green' | 'red' | 'yellow' | 'blue';

function StatCard({
  title,
  value,
  sub,
  icon,
  accent,
}: {
  title: string;
  value: number;
  sub: string;
  icon: React.ReactNode;
  accent?: Accent;
}) {
  const accentClasses: Record<Accent, string> = {
    green: 'border-l-4 border-l-green-500',
    red: 'border-l-4 border-l-red-500',
    yellow: 'border-l-4 border-l-yellow-500',
    blue: 'border-l-4 border-l-blue-500',
  };

  return (
    <Card className={`transition-colors hover:bg-muted/40 cursor-pointer${accent ? ` ${accentClasses[accent]}` : ''}`}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value.toLocaleString()}</div>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}
