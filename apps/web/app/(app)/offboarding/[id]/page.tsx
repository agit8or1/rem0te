'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Check, CircleSlash, Clock, Info, Loader2, RefreshCw, Wifi, WifiOff, X,
} from 'lucide-react';
import { businessesApi, offboardingApi } from '@/lib/api-client';
import { PageHeader } from '@/components/common/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth';
import { cn, formatDate } from '@/lib/utils';

// ─── Types (OffboardingService.get) ──────────────────────────────────────────

type StepState = 'done' | 'pending' | 'skipped' | 'failed';
interface Step { key: string; label: string; state: StepState; detail?: string; count?: number }
interface Rotation {
  endpointId: string;
  name: string;
  stagedAt: string | null;
  error?: string;
  state: 'pending' | 'confirmed' | 'failed';
  confirmedAt: string | null;
  online: boolean;
  lastSeenAt: string | null;
  note?: string;
}
interface Case {
  id: string;
  subject: { id: string; email: string; status: string } | null;
  businessId: string | null;
  startedAt: string;
  completedAt: string | null;
  notes: string | null;
  steps: Step[];
  rotations: Rotation[];
  rotationSummary: { total: number; confirmed: number; pending: number; failed: number; offlinePending: number };
}

type ApiErr = { response?: { status?: number; data?: { message?: string | string[] } } };
function errMsg(e: unknown): string | undefined {
  const m = (e as ApiErr)?.response?.data?.message;
  return Array.isArray(m) ? m.join('; ') : m;
}

const POLL_MS = 20_000;

/**
 * Keep polling while a rotation is unconfirmed, or while every step is
 * settled but the server has not stamped `completedAt` yet (it does so on a
 * read, so the next poll shows it).
 */
function shouldPoll(c: Case | undefined): boolean {
  if (!c) return false;
  if (c.rotationSummary.pending > 0) return true;
  return !c.completedAt && c.steps.every((s) => s.state === 'done' || s.state === 'skipped');
}

const STEP_ICON: Record<StepState, { icon: typeof Check; className: string; label: string }> = {
  done: { icon: Check, className: 'text-green-700 bg-green-100 dark:text-green-300 dark:bg-green-900/60', label: 'Done' },
  pending: { icon: Clock, className: 'text-amber-800 bg-amber-100 dark:text-amber-200 dark:bg-amber-900/60', label: 'Pending' },
  skipped: { icon: CircleSlash, className: 'text-muted-foreground bg-muted', label: 'Nothing to do' },
  failed: { icon: X, className: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/60', label: 'Failed' },
};

export default function OffboardingCasePage() {
  const { id } = useParams<{ id: string }>();
  const { isPlatformAdmin, businessId: ownBusinessId, businessName } = usePermissions();

  const { data: c, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery<Case>({
    queryKey: ['offboarding', 'case', id],
    queryFn: () => offboardingApi.get(id).then((r) => r.data?.data),
    refetchInterval: (q) => (shouldPoll(q.state.data) ? POLL_MS : false),
    retry: false,
  });

  const { data: business } = useQuery<{ id: string; name: string }>({
    queryKey: ['business', c?.businessId],
    queryFn: () => businessesApi.get(c!.businessId!).then((r) => r.data?.data),
    enabled: !!c?.businessId && isPlatformAdmin,
    retry: false,
  });
  const scopeName = !c ? '' : !c.businessId ? 'Every business'
    : business?.name ?? (c.businessId === ownBusinessId ? businessName : null) ?? 'One business';

  const polling = shouldPoll(c);

  return (
    <div className="space-y-6 p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/offboarding"><ArrowLeft className="mr-1 h-4 w-4" />Offboarding</Link>
      </Button>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : error || !c ? (
        <Card><CardContent className="p-6 text-sm text-destructive">{errMsg(error) ?? 'Offboarding case not found.'}</CardContent></Card>
      ) : (
        <>
          <PageHeader
            title={`Offboarding: ${c.subject?.email ?? 'unknown person'}`}
            description={`${scopeName} · started ${formatDate(c.startedAt)}${c.subject ? ` · account ${c.subject.status.toLowerCase()}` : ''}`}
          >
            {c.completedAt
              ? <Badge variant="success" className="text-sm">Complete · {formatDate(c.completedAt)}</Badge>
              : <Badge variant="warning" className="text-sm"><Clock className="mr-1 h-3.5 w-3.5" />In progress</Badge>}
          </PageHeader>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {polling ? <span>Checking every 20 seconds while anything is pending.</span> : <span>Not refreshing automatically.</span>}
            <span>Last checked {formatDate(new Date(dataUpdatedAt))}.</span>
            <Button variant="outline" size="sm" className="h-7" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Refresh
            </Button>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Steps</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {c.steps.map((s) => {
                const st = STEP_ICON[s.state] ?? STEP_ICON.pending;
                const Icon = st.icon;
                return (
                  <div key={s.key} className="flex items-start gap-3 rounded-md border p-3 text-sm">
                    <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full', st.className)}><Icon className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.label}</span>
                        <span className="text-xs text-muted-foreground">{st.label}{typeof s.count === 'number' && s.count > 0 ? ` · ${s.count}` : ''}</span>
                      </div>
                      {s.detail && <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Credential rotation</CardTitle>
              <CardDescription>
                {c.rotationSummary.total === 0
                  ? 'No computer credentials were rotated in this offboarding.'
                  : `${c.rotationSummary.confirmed} of ${c.rotationSummary.total} confirmed by the computer` +
                    (c.rotationSummary.pending ? `, ${c.rotationSummary.pending} pending${c.rotationSummary.offlinePending ? ` (${c.rotationSummary.offlinePending} offline)` : ''}` : '') +
                    (c.rotationSummary.failed ? `, ${c.rotationSummary.failed} failed` : '') + '.'}
              </CardDescription>
            </CardHeader>
            {c.rotations.length > 0 && (
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Computer</th>
                        <th className="px-4 py-2 font-medium">Rotation</th>
                        <th className="px-4 py-2 font-medium">Connectivity</th>
                        <th className="px-4 py-2 font-medium">Staged</th>
                        <th className="px-4 py-2 font-medium">What it means</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {c.rotations.map((r) => (
                        <tr key={r.endpointId} className="align-top">
                          <td className="px-4 py-2"><Link className="hover:underline" href={`/endpoints/${r.endpointId}`}>{r.name}</Link></td>
                          <td className="px-4 py-2">
                            {r.state === 'confirmed' && <Badge variant="success">Confirmed{r.confirmedAt ? ` · ${formatDate(r.confirmedAt)}` : ''}</Badge>}
                            {r.state === 'pending' && <Badge variant="warning"><Clock className="mr-1 h-3 w-3" />Pending</Badge>}
                            {r.state === 'failed' && <Badge variant="destructive">Failed</Badge>}
                          </td>
                          <td className="px-4 py-2">
                            {r.online
                              ? <span className="flex items-center gap-1 text-green-700 dark:text-green-400"><Wifi className="h-3.5 w-3.5" />Online</span>
                              : <span className="flex items-center gap-1 text-muted-foreground"><WifiOff className="h-3.5 w-3.5" />Offline{r.lastSeenAt ? ` · seen ${formatDate(r.lastSeenAt)}` : ''}</span>}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(r.stagedAt)}</td>
                          <td className="max-w-sm px-4 py-2 text-xs">
                            {r.state === 'failed' && <span className="text-destructive">{r.error ?? 'Could not stage the rotation.'} The old password still works.</span>}
                            {r.state === 'pending' && <span className="text-muted-foreground">{r.note ?? 'Waiting for the computer to confirm. The old password still works until then.'}</span>}
                            {r.state === 'confirmed' && <span className="text-muted-foreground">The computer applied the new password. The old one no longer works for new connections.</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            )}
          </Card>

          {c.notes && (
            <Card>
              <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm">{c.notes}</CardContent>
            </Card>
          )}

          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Removing access stopped new connections through Rem0te. It did not change any RustDesk password this person already saw; only a confirmed rotation does that.
              Neither removal nor rotation ends a RustDesk session that is already open.
              This case is marked complete only when every step is done or had nothing to do.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
