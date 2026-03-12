'use client';
import { useQuery } from '@tanstack/react-query';
import { portalApi } from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const STATUS_LABELS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  PENDING: { label: 'Waiting', variant: 'secondary' },
  SESSION_STARTED: { label: 'In Progress', variant: 'default' },
  SESSION_COMPLETED: { label: 'Completed', variant: 'outline' },
  CANCELED: { label: 'Cancelled', variant: 'destructive' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

export default function PortalSessionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['portal-sessions'],
    queryFn: () => portalApi.sessions().then(r => r.data?.data ?? []),
  });
  const sessions = Array.isArray(data) ? data : [];

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading sessions&hellip;</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Support Sessions</h1>
        <p className="text-muted-foreground text-sm mt-1">History of all remote support sessions for your devices.</p>
      </div>
      {sessions.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">No sessions yet.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Device</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Issue</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Technician</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s: Record<string, unknown>) => {
                  const tech = s.technician as Record<string, unknown> | undefined;
                  const ep = s.endpoint as Record<string, unknown> | undefined;
                  const st = STATUS_LABELS[s.status as string] ?? { label: s.status as string, variant: 'secondary' as const };
                  return (
                    <tr key={s.id as string} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">{ep?.name as string ?? 'Ad-hoc'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{s.issueDescription as string ?? '—'}</td>
                      <td className="px-4 py-3">{tech ? `${tech.firstName} ${tech.lastName}` : '—'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(s.createdAt as string).toLocaleDateString()}</td>
                      <td className="px-4 py-3"><Badge variant={st.variant}>{st.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
