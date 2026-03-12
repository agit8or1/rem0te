'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { auditApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const ACTION_COLORS: Record<string, string> = {
  LOGIN_SUCCESS: 'bg-green-100 text-green-700',
  LOGIN_FAILURE: 'bg-red-100 text-red-700',
  LOGOUT: 'bg-gray-100 text-gray-700',
  USER_CREATED: 'bg-blue-100 text-blue-700',
  USER_SUSPENDED: 'bg-red-100 text-red-700',
  TENANT_CREATED: 'bg-purple-100 text-purple-700',
  ENDPOINT_CLAIMED: 'bg-teal-100 text-teal-700',
  SESSION_LAUNCHED: 'bg-orange-100 text-orange-700',
  SESSION_COMPLETED: 'bg-green-100 text-green-700',
};

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_COLORS[action] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {action.replace(/_/g, ' ')}
    </span>
  );
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [actorId, setActorId] = useState('');
  const [resource, setResource] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, actorId, resource],
    queryFn: () =>
      auditApi
        .list({
          page: String(page),
          limit: '50',
          ...(actorId && { actorId }),
          ...(resource && { resource }),
        })
        .then((r) => r.data?.data),
    placeholderData: (prev: unknown) => prev,
  });

  const logs: Record<string, unknown>[] = (data as { logs?: Record<string, unknown>[] })?.logs ?? [];
  const totalPages: number = (data as { pages?: number })?.pages ?? 1;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Audit Log" description="Immutable activity trail" />

      <div className="flex gap-3 flex-wrap">
        <Input
          placeholder="Filter by actor ID…"
          className="max-w-[200px]"
          value={actorId}
          onChange={(e) => { setActorId(e.target.value); setPage(1); }}
        />
        <Input
          placeholder="Filter by resource…"
          className="max-w-[200px]"
          value={resource}
          onChange={(e) => { setResource(e.target.value); setPage(1); }}
        />
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border bg-background overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium">Time</th>
                <th className="text-left px-4 py-3 font-medium">Action</th>
                <th className="text-left px-4 py-3 font-medium">Actor</th>
                <th className="text-left px-4 py-3 font-medium">Resource</th>
                <th className="text-left px-4 py-3 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-muted-foreground">
                    No log entries.
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const actor = log.actor as { email?: string } | null;
                  return (
                    <tr key={log.id as string} className="hover:bg-muted/30">
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(log.createdAt as string)}
                      </td>
                      <td className="px-4 py-3">
                        <ActionBadge action={log.action as string} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {actor?.email ?? (log.actorId ? (log.actorId as string).slice(0, 8) + '…' : '—')}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {log.resource ? (
                          <span>
                            {log.resource as string}
                            {log.resourceId ? (
                              <span className="font-mono text-xs ml-1">
                                #{(log.resourceId as string).slice(0, 8)}
                              </span>
                            ) : null}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {(log.actorIp as string) ?? '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
