'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { endpointsApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StatusIndicator } from '@/components/common/status-indicator';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '@/lib/utils';

export default function EndpointsPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['endpoints', search],
    queryFn: () =>
      endpointsApi.list(search ? { search } : undefined).then((r) => r.data?.data),
    refetchInterval: 30_000,
  });

  const endpoints: Record<string, unknown>[] = data?.endpoints ?? [];

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Endpoints" description="Manage your remote devices">
        <Link href="/endpoints/new">
          <Button size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Add Endpoint
          </Button>
        </Link>
      </PageHeader>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search endpoints…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Customer</th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">RustDesk ID</th>
                <th className="text-left px-4 py-3 font-medium">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {endpoints.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No endpoints found.
                  </td>
                </tr>
              ) : (
                endpoints.map((ep) => {
                  const customer = ep.customer as { name?: string } | null;
                  return (
                    <tr key={ep.id as string} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link
                          href={`/endpoints/${ep.id as string}`}
                          className="font-medium hover:underline"
                        >
                          {ep.name as string}
                        </Link>
                        {ep.hostname ? (
                          <p className="text-xs text-muted-foreground">{ep.hostname as string}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {customer?.name ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        {ep.platform ? (
                          <Badge variant="secondary">{ep.platform as string}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {(ep.rustdeskId as string) ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {formatDate(ep.lastSeenAt as string)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusIndicator status={(ep.isOnline as boolean) ? 'online' : 'offline'} />
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
