'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { endpointsApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import { ago } from '@/components/endpoints/workspace/device-model';
import { connectivityHint, connectivityLabel, connectivityOf } from '@/lib/connectivity';

/**
 * Agent migrations (0.34): every per-computer move from the standard agent to
 * the signed agent that is still open, and those finished in the last 30
 * days, on the computers this person can see. The states are the server's
 * (agent-migration.ts migrationState); "Not confirmed" is a request handed out
 * over two hours ago whose computer still reports the standard agent.
 */
type State = 'pending' | 'held' | 'dispatched' | 'downloaded' | 'not_confirmed' | 'completed' | 'cancelled';
interface Row {
  id: string; endpointId: string; name: string; business: { id: string; name: string } | null; online: boolean; lastSeenAt: string | null;
  agentVersion: string | null; channel: 'signed' | 'standard'; lastUpdate: { checkedAt: string; result: string | null } | null;
  state: State; text: string; reason: string; requestedAt: string; dispatchedAt: string | null; dispatchCount: number;
  fetchedAt: string | null; completedAt: string | null; cancelledAt: string | null;
}
interface Data { counts: Record<State, number>; rows: Row[]; total: number }

const LABEL: Record<State, string> = {
  pending: 'Pending', held: 'Held', dispatched: 'Handed out', downloaded: 'Downloaded',
  not_confirmed: 'Not confirmed', completed: 'Completed', cancelled: 'Cancelled',
};
const FILTERS: { value: string; label: string }[] = [
  { value: 'open', label: 'Open (everything not finished)' },
  { value: 'not_confirmed', label: 'Not confirmed' },
  { value: 'held', label: 'Held' },
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed (30 days)' },
  { value: 'cancelled', label: 'Cancelled (30 days)' },
  { value: 'all', label: 'All (open and last 30 days)' },
];

export default function AgentMigrationsPage() {
  const { can } = usePermissions();
  const allowed = can(CAP.COMPUTERS_VIEW);
  const [state, setState] = React.useState('open');
  const { data, isLoading, isError } = useQuery<Data>({
    queryKey: ['agent-migrations', state],
    queryFn: () => endpointsApi.agentMigrations({ state }).then((r) => r.data?.data),
    enabled: allowed,
    refetchInterval: 60_000,
  });

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader
        title="Agent migrations"
        description="Computers being moved from the standard agent to the signed agent from the console, one request each. Request one from a computer's Agent card, or select several on All devices."
      />
      {!allowed ? <p className="text-sm text-muted-foreground">This page needs the View computers permission.</p> : (
        <>
          {data && (
            <div className="flex flex-wrap gap-2 text-xs" data-testid="migration-counts">
              {(Object.keys(LABEL) as State[]).map((s) => (
                <Badge key={s} variant={s === 'not_confirmed' && data.counts[s] ? 'destructive' : 'secondary'}>{LABEL[s]}: {data.counts[s] ?? 0}</Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Select value={state} onValueChange={setState}>
              <SelectTrigger className="h-9 w-[260px]" aria-label="Which requests"><SelectValue /></SelectTrigger>
              <SelectContent>{FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
            <Link href="/docs/update-signing#moving-existing-agents" className="text-xs underline text-muted-foreground">How migration works</Link>
          </div>
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {isError && <p className="text-sm text-destructive">The list could not be loaded.</p>}
          {data && data.rows.length === 0 && (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No requests in this view.</CardContent></Card>
          )}
          {data && data.rows.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm" data-testid="migration-table">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="px-3 py-2 font-medium">Device</th>
                    <th className="px-3 py-2 font-medium">Business</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Agent now</th>
                    <th className="px-3 py-2 font-medium">Last update result</th>
                    <th className="px-3 py-2 font-medium">Requested</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="px-3 py-2">
                        <Link href={`/endpoints/${r.endpointId}`} className="font-medium hover:underline">{r.name}</Link>
                        <p className="text-xs text-muted-foreground" title={connectivityHint(connectivityOf(r.online, r.lastSeenAt))}>{connectivityOf(r.online, r.lastSeenAt) === 'offline' ? `Offline · seen ${ago(r.lastSeenAt)}` : connectivityLabel(connectivityOf(r.online, r.lastSeenAt), r.lastSeenAt)}</p>
                      </td>
                      <td className="px-3 py-2">{r.business?.name ?? '—'}</td>
                      <td className="px-3 py-2 max-w-[22rem]">
                        <Badge variant={r.state === 'not_confirmed' ? 'destructive' : r.state === 'completed' ? 'secondary' : 'outline'}>{LABEL[r.state]}</Badge>
                        <p className="mt-1 text-xs text-muted-foreground">{r.text}</p>
                        {r.dispatchCount > 0 && <p className="text-xs text-muted-foreground">Handed out {r.dispatchCount}×{r.fetchedAt ? `, downloaded ${ago(r.fetchedAt)}` : ''}</p>}
                      </td>
                      <td className="px-3 py-2">{r.channel === 'signed' ? 'Signed' : 'Standard'}{r.agentVersion ? ` ${r.agentVersion}` : ''}</td>
                      <td className="px-3 py-2 max-w-[18rem] text-xs">{r.lastUpdate ? <span title={formatDate(r.lastUpdate.checkedAt)}>{r.lastUpdate.result || '—'} · {ago(r.lastUpdate.checkedAt)}</span> : <span className="text-muted-foreground">Not reported</span>}</td>
                      <td className="px-3 py-2 text-xs">
                        <span title={formatDate(r.requestedAt)}>{ago(r.requestedAt)}</span>
                        <p className="text-muted-foreground break-words">“{r.reason}”</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && data.total > data.rows.length && <p className="text-xs text-muted-foreground">Showing {data.rows.length} of {data.total}.</p>}
        </>
      )}
    </div>
  );
}
