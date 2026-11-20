'use client';
import { shownAgentVersion, type AgentVersionView } from '@/lib/agent-version';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { msaApi } from '@/lib/api-client';
import { usePermissions, CAP } from '@/lib/auth';
import { formatDate } from '@/lib/utils';
import { MSA_FLEET_NOTE, MsaNote, MsaStateBadge, type MsaState } from '@/components/endpoints/msa-readiness';

/**
 * Devices → Remote access readiness (0.69): Managed Secure Access readiness
 * for every computer this person can see, from GET /msa/readiness
 * (computers:view; the API reads computers only through
 * endpointVisibilityWhere). Read-only: there is no control on this page,
 * because there is nothing yet to turn on.
 */

type State = 'unsupported' | 'upgrade_available' | 'compatible' | 'unknown';
interface Row {
  id: string; name: string; hostname: string | null; platform: string | null; agentVersion: string | null; versionView?: AgentVersionView;
  business: { id: string; name: string } | null;
  state: State; label: string; reasons: string[]; rustdeskVersion: string | null; checkedAt: string | null; labTested: boolean | null;
}
interface Fleet {
  note: string; generatedAt: string;
  states: { state: State; label: string }[];
  counts: Record<State, number>; total: number; truncated: boolean;
  computers: Row[];
  labTested: { versions: string[]; min: string; max: string };
  minAgent: string;
}

const EXPLAIN: Record<State, string> = {
  compatible: 'The signed agent, an installed RustDesk on a lab-tested release, and every read-only check answered. Still Legacy.',
  upgrade_available: 'Would be compatible after the signed agent or RustDesk is updated (or RustDesk is reinstalled in its standard place).',
  unsupported: 'Linux, macOS, the standard agent, or a Sciter build of RustDesk. Stays Legacy.',
  unknown: 'No current report: offline, not reported yet, a report over 7 days old, or a check that did not answer.',
};

export default function RemoteReadinessPage() {
  const { can } = usePermissions();
  const allowed = can(CAP.COMPUTERS_VIEW);
  const [filter, setFilter] = React.useState<State | null>(null);
  const { data, isLoading, isError } = useQuery<Fleet>({
    queryKey: ['msa-readiness-fleet'],
    queryFn: () => msaApi.fleet().then((r) => r.data?.data),
    enabled: allowed,
    refetchInterval: 60_000,
  });
  const rows = (data?.computers ?? []).filter((c) => !filter || c.state === filter);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader
        title="Remote access readiness"
        description="Whether each computer could later use Managed Secure Access: short-lived, per-session RustDesk access applied and checked by the signed agent. Read from what the agents report."
      />
      {!allowed ? <p className="text-sm text-muted-foreground">This page needs the View computers permission.</p> : (
        <>
          <MsaNote text={data?.note ?? MSA_FLEET_NOTE} testId="msa-fleet-note" />
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {isError && <p className="text-sm text-destructive">Readiness could not be loaded.</p>}
          {data && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="msa-fleet-counts">
                {data.states.map((s) => (
                  <button
                    key={s.state}
                    type="button"
                    onClick={() => setFilter(filter === s.state ? null : s.state)}
                    aria-pressed={filter === s.state}
                    data-testid={`msa-count-${s.state}`}
                    className={`rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filter === s.state ? 'ring-2 ring-ring' : ''}`}
                  >
                    <div className="text-2xl font-semibold tabular-nums">{data.counts[s.state]}</div>
                    <div className="mt-1"><MsaStateBadge state={s.state as MsaState} label={s.label} /></div>
                    <p className="mt-1.5 text-xs text-muted-foreground">{EXPLAIN[s.state]}</p>
                  </button>
                ))}
              </div>

              <Card>
                <CardContent className="p-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3 text-sm">
                    <span className="font-medium">
                      {filter ? `${data.states.find((s) => s.state === filter)?.label}: ${rows.length}` : `All computers: ${data.total}`}
                    </span>
                    {filter && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setFilter(null)} data-testid="msa-filter-clear">Show all</Button>}
                  </div>
                  {rows.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">No computers{filter ? ' in this state' : ''}.</p>
                  ) : (
                    <ul className="divide-y" data-testid="msa-fleet-rows">
                      {rows.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 p-3 text-xs" data-state={r.state}>
                          <div className="min-w-0 flex-1 basis-48">
                            <Link href={`/endpoints/${r.id}`} className="text-sm font-medium hover:underline break-all">{r.name}</Link>
                            <p className="text-muted-foreground break-words">
                              {r.business?.name ?? 'Unassigned'}{shownAgentVersion(r.versionView, r.agentVersion) ? ` · agent ${shownAgentVersion(r.versionView, r.agentVersion)}` : ''}
                              {r.rustdeskVersion ? ` · RustDesk ${r.rustdeskVersion}` : ''}
                            </p>
                          </div>
                          <div className="min-w-0 flex-[2] basis-64">
                            <MsaStateBadge state={r.state} label={r.label} />
                            <p className="mt-1 text-muted-foreground">{r.reasons[0]}</p>
                            {r.checkedAt && <p className="mt-0.5 text-muted-foreground">Checked {formatDate(r.checkedAt)}</p>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.truncated && <p className="border-t p-3 text-xs text-muted-foreground">Showing the first {data.total} computers.</p>}
                </CardContent>
              </Card>

              <p className="text-xs text-muted-foreground">
                Lab-tested RustDesk releases: {data.labTested.versions.join(', ')} (on Windows Server, as SYSTEM). Agents report from {data.minAgent}; signed agents
                update themselves under <Link className="underline" href="/settings/client-updates">Settings → Client updates</Link>.
                {' '}More: <Link className="underline" href="/docs/managed-secure-access">Managed Secure Access</Link>.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
