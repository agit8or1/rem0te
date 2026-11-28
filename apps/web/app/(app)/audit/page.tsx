'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { auditApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Input } from '@/components/ui/input';

import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const ACTION_COLORS: Record<string, string> = {
  LOGIN_SUCCESS: 'bg-green-100 text-green-700',
  LOGIN_FAILURE: 'bg-red-100 text-red-700',
  LOGOUT: 'bg-gray-100 text-gray-700',
  USER_CREATED: 'bg-blue-100 text-blue-700',
  USER_SUSPENDED: 'bg-red-100 text-red-700',
  USER_DELETED: 'bg-red-100 text-red-700',
  USER_CAPABILITIES_UPDATED: 'bg-indigo-100 text-indigo-700',
  ROLE_CHANGED: 'bg-indigo-100 text-indigo-700',
  BUSINESS_CREATED: 'bg-purple-100 text-purple-700',
  BUSINESS_UPDATED: 'bg-purple-100 text-purple-700',
  BUSINESS_DISABLED: 'bg-red-100 text-red-700',
  BUSINESS_DELETED: 'bg-red-100 text-red-700',
  ENDPOINT_CLAIMED: 'bg-teal-100 text-teal-700',
  SESSION_LAUNCHED: 'bg-orange-100 text-orange-700',
  SESSION_COMPLETED: 'bg-green-100 text-green-700',
  QUICK_CONNECT_INITIATED: 'bg-amber-100 text-amber-700',
  QUICK_CONNECT_ENDED: 'bg-green-100 text-green-700',
  CHAT_STARTED: 'bg-sky-100 text-sky-700',
  CHAT_ENDED: 'bg-gray-100 text-gray-700',
  CHAT_PRUNED: 'bg-gray-100 text-gray-700',
  CHAT_ATTACHMENT_SENT: 'bg-sky-100 text-sky-700',
  QUICK_CONNECT_DENIED: 'bg-red-100 text-red-700',
  QUICK_CONNECT_SETTING_CHANGED: 'bg-amber-100 text-amber-700',
  PLATFORM_SETTINGS_UPDATED: 'bg-purple-100 text-purple-700',
  CONNECTION_GRANT_DENIED: 'bg-red-100 text-red-700',
  ENDPOINT_PASSWORD_REVEALED: 'bg-yellow-100 text-yellow-700',
  ENDPOINT_LIST_EXPORTED: 'bg-yellow-100 text-yellow-700',
  REPORT_EXPORTED: 'bg-yellow-100 text-yellow-700',
  ENDPOINT_DIAGNOSTIC_REQUESTED: 'bg-sky-100 text-sky-700',
  ENDPOINT_DIAGNOSTIC_COMPLETED: 'bg-sky-100 text-sky-700',
  SNAPSHOT_SCHEDULE_CHANGED: 'bg-sky-100 text-sky-700',
};

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_COLORS[action] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {action.replace(/_/g, ' ')}
    </span>
  );
}

// useSearchParams needs a Suspense boundary under the App Router.
export default function AuditPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <AuditLog />
    </Suspense>
  );
}

/**
 * 0.93 (UX P1-7): ?resource=&resourceId=&action= open the log on one record
 * (a terminal session, a file transfer, a device's diagnostics). The API
 * applies them inside the caller's own scope, so a link narrows, never widens.
 */
function AuditLog() {
  const sp = useSearchParams();
  const resourceId = sp.get('resourceId') ?? '';
  const action = sp.get('action') ?? '';
  const [page, setPage] = useState(1);
  const [actorId, setActorId] = useState('');
  const [resource, setResource] = useState(sp.get('resource') ?? '');

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', page, actorId, resource, resourceId, action],
    queryFn: () =>
      auditApi
        .list({
          page: String(page),
          limit: '50',
          ...(actorId && { actorId }),
          ...(resource && { resource }),
          ...(resourceId && { resourceId }),
          ...(action && { action }),
        })
        .then((r) => r.data?.data),
    placeholderData: (prev: unknown) => prev,
  });

  const logs: Record<string, unknown>[] = (data as { logs?: Record<string, unknown>[] })?.logs ?? [];
  const totalPages: number = (data as { pages?: number })?.pages ?? 1;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Audit log" description="Immutable activity trail" />

      {(resourceId || action) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="audit-record-filter">
          <span>
            Showing {action ? <><code className="text-xs">{action}</code> entries</> : 'entries'}
            {resourceId ? <> for {resource || 'record'} <code className="text-xs">{resourceId}</code></> : null}
          </span>
          <Link href="/audit" className="text-primary hover:underline">Show everything</Link>
        </div>
      )}
      {error ? <p className="text-sm text-destructive" data-testid="audit-error">{(error as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'The audit log could not be read.'}</p> : null}

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
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
