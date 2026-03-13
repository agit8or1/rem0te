'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { adminApi, authApi, tenantsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusIndicator } from '@/components/common/status-indicator';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/utils';

export default function UnassignedDevicesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string>('');

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().then((r) => r.data?.data),
  });

  if (me && !me.isPlatformAdmin) {
    router.push('/dashboard');
    return null;
  }

  const { data: devicesData, isLoading } = useQuery({
    queryKey: ['unassigned-devices'],
    queryFn: () => adminApi.listUnassigned().then((r) => r.data?.data),
    refetchInterval: 30_000,
  });

  const { data: tenantsData } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => tenantsApi.list().then((r) => r.data?.data),
  });

  const devices: Record<string, unknown>[] = devicesData ?? [];
  const tenants: Record<string, unknown>[] = tenantsData?.tenants ?? tenantsData ?? [];

  const assignMutation = useMutation({
    mutationFn: ({ id, tenantId }: { id: string; tenantId: string }) =>
      adminApi.assignDevice(id, tenantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unassigned-devices'] });
      setAssigningId(null);
      setSelectedTenant('');
      toast({ title: 'Device assigned', description: 'The device has been assigned to the selected tenant.' });
    },
    onError: () => {
      toast({ title: 'Assignment failed', description: 'Could not assign the device.', variant: 'destructive' });
    },
  });

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Unassigned Devices"
        description="Devices that enrolled without a tenant link — only visible to platform admins"
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
                    No unassigned devices.
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
                              value={selectedTenant}
                              onChange={(e) => setSelectedTenant(e.target.value)}
                            >
                              <option value="">Select tenant…</option>
                              {tenants.map((t) => (
                                <option key={t.id as string} value={t.id as string}>
                                  {t.name as string}
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              disabled={!selectedTenant || assignMutation.isPending}
                              onClick={() => assignMutation.mutate({ id, tenantId: selectedTenant })}
                            >
                              Assign
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setAssigningId(null); setSelectedTenant(''); }}
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
