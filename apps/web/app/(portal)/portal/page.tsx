'use client';
import { useQuery } from '@tanstack/react-query';
import { portalApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Monitor, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export default function PortalDashboard() {
  const { data: meData } = useQuery({
    queryKey: ['portal-me'],
    queryFn: () => portalApi.me().then(r => r.data?.data),
  });
  const { data: endpointsData } = useQuery({
    queryKey: ['portal-endpoints'],
    queryFn: () => portalApi.endpoints().then(r => r.data?.data ?? []),
  });
  const { data: sessionsData } = useQuery({
    queryKey: ['portal-sessions'],
    queryFn: () => portalApi.sessions().then(r => r.data?.data ?? []),
  });

  const endpoints = Array.isArray(endpointsData) ? endpointsData : [];
  const sessions = Array.isArray(sessionsData) ? sessionsData : [];
  const onlineCount = endpoints.filter((e: Record<string, unknown>) => e.isOnline).length;
  const activeSessions = sessions.filter((s: Record<string, unknown>) => !['SESSION_COMPLETED', 'CANCELED', 'FAILED'].includes(s.status as string));

  const customer = meData?.customer as Record<string, unknown> | undefined;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome back{customer?.name ? `, ${customer.name}` : ''}</h1>
        <p className="text-muted-foreground text-sm mt-1">Here&apos;s an overview of your devices and support sessions.</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Devices</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{endpoints.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Online Now</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{onlineCount}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Active Sessions</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{activeSessions.length}</div></CardContent>
        </Card>
      </div>

      <div className="flex gap-4">
        <Link href="/portal/endpoints">
          <Button variant="outline">
            <Monitor className="h-4 w-4 mr-2" />
            View My Devices
          </Button>
        </Link>
        <Link href="/portal/sessions/new">
          <Button>
            <PlayCircle className="h-4 w-4 mr-2" />
            Request Support
          </Button>
        </Link>
      </div>

      {sessions.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Recent Sessions</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {sessions.slice(0, 5).map((s: Record<string, unknown>) => (
                <div key={s.id as string} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">
                      {(s.endpoint as Record<string, unknown>)?.name as string ?? 'Ad-hoc session'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.issueDescription as string ?? 'No description'} &middot; {new Date(s.createdAt as string).toLocaleDateString()}
                    </div>
                  </div>
                  <span className={cn(
                    'text-xs px-2 py-1 rounded-full font-medium',
                    s.status === 'SESSION_COMPLETED' ? 'bg-green-100 text-green-700' :
                    s.status === 'PENDING' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-blue-100 text-blue-700',
                  )}>{(s.status as string).replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
