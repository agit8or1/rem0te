'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { adminApi, businessesApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusIndicator } from '@/components/common/status-indicator';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';
import { usePermissions } from '@/lib/auth';

export default function UnassignedDevicesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [selectedBusiness, setSelectedBusiness] = useState<string>('');
  const { isPlatformAdmin, isLoading: authLoading } = usePermissions();
  const allowed = authLoading || isPlatformAdmin;

  // Every hook must run on every render — bailing out with an early return
  // above them changes the hook count between renders and React throws
  // "Rendered fewer hooks than expected". Gate the *queries* instead and
  // redirect from an effect.
  const { data: devicesData, isLoading } = useQuery({
    queryKey: ['unassigned-devices'],
    queryFn: () => adminApi.listUnassigned().then((r) => r.data?.data),
    refetchInterval: 30_000,
    enabled: allowed,
  });

  const { data: businessesData } = useQuery({
    queryKey: ['businesses', ''],
    queryFn: () => businessesApi.list().then((r) => r.data?.data ?? []),
    enabled: allowed,
  });

  const devices: Record<string, unknown>[] = devicesData ?? [];
  const businesses: Record<string, unknown>[] = Array.isArray(businessesData) ? businessesData : [];

  const assignMutation = useMutation({
    mutationFn: ({ id, businessId }: { id: string; businessId: string }) =>
      adminApi.assignDevice(id, businessId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unassigned-devices'] });
      queryClient.invalidateQueries({ queryKey: ['endpoints'] });
      setAssigningId(null);
      setSelectedBusiness('');
      toast({ title: 'Computer assigned', description: 'It now belongs to the selected business.' });
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast({ title: 'Assignment failed', description: e.response?.data?.message, variant: 'destructive' });
    },
  });

  useEffect(() => {
    if (!authLoading && !isPlatformAdmin) router.push('/dashboard');
  }, [authLoading, isPlatformAdmin, router]);

  if (!allowed) return null;

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Unassigned Computers"
        description="Computers that checked in but do not belong to a business yet. Platform Admins only."
      />

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">RustDesk ID</th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">Hostname</th>
                <th className="text-left px-4 py-3 font-medium">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium">Online</th>
                <th className="text-left px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-muted-foreground">
                    No unassigned computers.
                  </td>
                </tr>
              ) : (
                devices.map((dev) => {
                  const node = dev.rustdeskNode as Record<string, unknown> | null;
                  const id = dev.id as string;
                  return (
                    <tr key={id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{dev.name as string}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {(node?.rustdeskId as string) ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        {dev.platform ? (
                          <Badge variant="secondary">{dev.platform as string}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {(dev.hostname as string) ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {formatDate((node?.lastSeenAt ?? dev.lastSeenAt) as string)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusIndicator status={(dev.isOnline as boolean) ? 'online' : 'offline'} />
                      </td>
                      <td className="px-4 py-3">
                        {assigningId === id ? (
                          <div className="flex items-center gap-2">
                            <select
                              className="text-xs border rounded px-2 py-1 bg-background"
                              value={selectedBusiness}
                              onChange={(e) => setSelectedBusiness(e.target.value)}
                            >
                              <option value="">Select business…</option>
                              {businesses.map((b) => (
                                <option key={b.id as string} value={b.id as string}>
                                  {b.name as string}
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              disabled={!selectedBusiness || assignMutation.isPending}
                              onClick={() => assignMutation.mutate({ id, businessId: selectedBusiness })}
                            >
                              Assign
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setAssigningId(null); setSelectedBusiness(''); }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => setAssigningId(id)}>
                            Assign
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
