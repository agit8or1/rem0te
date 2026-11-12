'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rolloutsApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { errorMessage } from '@/lib/webauthn';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  JOB_DONE, JOB_LABEL, JobEventList, JobStatusBadge, RegistrationNote, RolloutStatusBadge,
  type JobStatus, type RolloutStatus, type UpdateJob,
} from '@/components/rollouts/endpoint-update-history';
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Pause, Play, XCircle } from 'lucide-react';
import { ConnectivityIndicator } from '@/components/common/connectivity-indicator';

interface JobRow extends UpdateJob {
  endpoint: {
    id: string; name: string; hostname: string | null; isOnline: boolean; lastSeenAt: string | null;
    customer: { name: string } | null;
  } | null;
}
interface Schedule { timeZone: string; windows: { days: number[]; start: string; end: string }[] }
interface RolloutDetail {
  id: string; name: string; component: 'RUSTDESK' | 'AGENT'; targetVersion: string;
  artifactName: string | null; artifactSha256: string | null; status: RolloutStatus;
  pilotGroupId: string | null; pilotGroup: { id: string; name: string } | null;
  batchSize: number; currentBatch: number; failureThreshold: number; maxAttempts: number;
  backoffMinutes: number; verifyTimeoutMinutes: number; maintenanceWindow: Schedule | null;
  deferOnUnknownSession: boolean; pausedReason: string | null;
  createdAt: string; startedAt: string | null; completedAt: string | null; canceledAt: string | null;
  counts: Partial<Record<JobStatus, number>>;
  jobs: JobRow[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_ORDER: JobStatus[] = [
  'REQUESTED', 'DISPATCHED', 'INSTALLING', 'AWAITING_VERIFICATION', 'SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED',
];

const CREDENTIAL_SYNC: Record<string, string> = {
  reported: 're-reported its RustDesk password after the install',
  unchanged: 'did not re-report its RustDesk password',
  unknown: 'unknown',
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function JobItem({
  job, maxAttempts, onCancel,
}: { job: JobRow; maxAttempts: number; onCancel: (j: JobRow) => void }) {
  const [open, setOpen] = useState(false);
  const done = JOB_DONE.includes(job.status);
  const name = job.endpoint?.name ?? job.endpointId;

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Hide events' : 'Show events'}
          className="text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <Link href={`/endpoints/${job.endpointId}`} className="text-sm font-medium hover:underline">{name}</Link>
        {job.endpoint?.customer && <span className="text-xs text-muted-foreground">{job.endpoint.customer.name}</span>}
        {job.endpoint && (
          <ConnectivityIndicator x={job.endpoint} short lowercase showDot={false} className="text-xs" />
        )}
        <JobStatusBadge status={job.status} />
        <RegistrationNote job={job} />
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-mono">{job.fromVersion ?? '?'} → {job.installedVersion ?? '—'}</span>
          <span className="tabular-nums">attempt {job.attempts}/{maxAttempts}</span>
          {!done && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => onCancel(job)}>
              Cancel
            </Button>
          )}
        </span>
      </div>

      <div className="pl-6 space-y-0.5 text-xs text-muted-foreground">
        {job.deferReason && job.status === 'REQUESTED' && <p>Deferred: {job.deferReason}</p>}
        {job.failureReason && (
          <p className={job.status === 'FAILED' ? 'text-destructive' : undefined}>
            {job.status === 'SKIPPED' ? 'Skipped' : job.status === 'REQUESTED' ? 'Last attempt failed' : job.status === 'CANCELED' ? 'Canceled' : 'Reason'}: {job.failureReason}
          </p>
        )}
        {job.status === 'REQUESTED' && job.nextAttemptAt && new Date(job.nextAttemptAt) > new Date() && (
          <p>Next attempt not before {formatDate(job.nextAttemptAt)}</p>
        )}
        {job.credentialSync && <p>Credential sync: the computer {CREDENTIAL_SYNC[job.credentialSync] ?? job.credentialSync}</p>}
      </div>

      {open && (
        <div className="mt-2 pl-6 space-y-2">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div><dt className="text-muted-foreground">Dispatched</dt><dd>{formatDate(job.dispatchedAt)}</dd></div>
            <div><dt className="text-muted-foreground">Installer fetched</dt><dd>{formatDate(job.installStartedAt)}</dd></div>
            <div><dt className="text-muted-foreground">Verified</dt><dd>{formatDate(job.verifiedAt)}</dd></div>
            <div><dt className="text-muted-foreground">Finished</dt><dd>{formatDate(job.completedAt)}</dd></div>
          </dl>
          <JobEventList events={job.events} />
        </div>
      )}
    </li>
  );
}

export default function RolloutDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isPlatformAdmin, isLoading: authLoading } = usePermissions();
  const allowed = authLoading || isPlatformAdmin;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelJob, setCancelJob] = useState<JobRow | null>(null);

  const key = ['rollout', id];
  const { data: r, isLoading, isError, error } = useQuery<RolloutDetail>({
    queryKey: key,
    queryFn: () => rolloutsApi.get(id).then((res) => res.data?.data),
    enabled: isPlatformAdmin && !!id,
    refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? 15_000 : false),
  });

  useEffect(() => {
    if (!authLoading && !isPlatformAdmin) router.push('/dashboard');
  }, [authLoading, isPlatformAdmin, router]);

  const onErr = (title: string) => (e: unknown) => toast({ title, description: errorMessage(e), variant: 'destructive' });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['rollouts'] });
  };

  const start = useMutation({
    mutationFn: () => rolloutsApi.start(id),
    onSuccess: (res) => {
      if (res.data?.data) qc.setQueryData(key, res.data.data);
      refresh();
      toast({ title: r?.status === 'PAUSED' ? 'Rollout resumed' : 'Rollout started' });
    },
    onError: onErr('Could not start'),
  });
  const pause = useMutation({
    mutationFn: () => rolloutsApi.pause(id),
    onSuccess: (res) => {
      refresh();
      toast({ title: res.data?.data?.paused ? 'Rollout paused' : 'Rollout was not running' });
    },
    onError: onErr('Could not pause'),
  });
  const cancel = useMutation({
    mutationFn: () => rolloutsApi.cancel(id),
    onSuccess: (res) => {
      if (res.data?.data) qc.setQueryData(key, res.data.data);
      setConfirmCancel(false);
      refresh();
      toast({ title: 'Rollout canceled' });
    },
    onError: onErr('Could not cancel'),
  });
  const cancelOne = useMutation({
    mutationFn: (jobId: string) => rolloutsApi.cancelJob(jobId),
    onSuccess: () => {
      setCancelJob(null);
      refresh();
      toast({ title: 'Job canceled' });
    },
    onError: onErr('Could not cancel job'),
  });

  const batches = useMemo(() => {
    const m = new Map<number, JobRow[]>();
    for (const j of r?.jobs ?? []) m.set(j.batch, [...(m.get(j.batch) ?? []), j]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [r?.jobs]);

  if (!allowed) return null;

  if (isLoading || authLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (isError || !r) {
    return (
      <div className="p-6 space-y-4">
        <Link href="/admin/rollouts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Staged updates
        </Link>
        <p className="text-sm text-destructive">{errorMessage(error, 'Rollout not found')}</p>
      </div>
    );
  }

  const active = (r.counts.DISPATCHED ?? 0) + (r.counts.INSTALLING ?? 0) + (r.counts.AWAITING_VERIFICATION ?? 0);
  const failed = r.counts.FAILED ?? 0;
  const canStart = r.status === 'DRAFT' || r.status === 'PAUSED';
  const canCancel = r.status !== 'COMPLETED' && r.status !== 'CANCELED';
  const unverified = r.jobs.filter((j) => j.status === 'SUCCEEDED' && j.events.some((e) => e.event === 'verified' && e.detail?.registration === 'unavailable')).length;
  const released = (batch: number) => r.status !== 'DRAFT' && batch <= r.currentBatch;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <Link href="/admin/rollouts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Staged updates
      </Link>
      <PageHeader
        title={r.name}
        description={`${r.component === 'RUSTDESK' ? 'RustDesk client' : 'Rem0te agent'} → ${r.targetVersion}`}
        actions={
          <>
            {canStart && (
              <Button onClick={() => start.mutate()} disabled={start.isPending}>
                <Play className="h-4 w-4 mr-1" /> {r.status === 'PAUSED' ? 'Resume' : 'Start'}
              </Button>
            )}
            {r.status === 'RUNNING' && (
              <Button variant="outline" onClick={() => pause.mutate()} disabled={pause.isPending}>
                <Pause className="h-4 w-4 mr-1" /> Pause
              </Button>
            )}
            {canCancel && (
              <Button variant="outline" className="text-destructive border-destructive/40 hover:bg-destructive/5" onClick={() => setConfirmCancel(true)}>
                <XCircle className="h-4 w-4 mr-1" /> Cancel rollout
              </Button>
            )}
          </>
        }
      />

      {r.status === 'PAUSED' && r.pausedReason && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{r.pausedReason}. {active > 0 && `${active} job(s) already dispatched are still being tracked and can still finish or time out.`}</span>
        </div>
      )}
      {r.status === 'DRAFT' && (
        <p className="text-sm text-muted-foreground">
          This is a draft: nothing has been sent to any computer. Review the jobs below, then start it.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">Status <RolloutStatusBadge status={r.status} /></CardTitle>
            <CardDescription>
              {r.status === 'RUNNING' ? 'Refreshes every 15 seconds while running. ' : ''}
              A job counts as succeeded only when an authenticated heartbeat reports the approved version and the computer is registered with the RustDesk server (or that check was unavailable, which is shown).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {STATUS_ORDER.filter((s) => r.counts[s]).map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm">
                  <JobStatusBadge status={s} /> <span className="tabular-nums font-medium">{r.counts[s]}</span>
                </span>
              ))}
              {r.jobs.length === 0 && <span className="text-sm text-muted-foreground">No jobs.</span>}
            </div>
            {unverified > 0 && (
              <p className="text-xs text-yellow-800 dark:text-yellow-300">
                {unverified} succeeded job(s) were verified by version and authenticated heartbeat only: the RustDesk server&apos;s
                presence check was unavailable, so registration was not independently verified.
              </p>
            )}
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Fact label="Current batch">{r.status === 'DRAFT' ? 'Not started' : r.currentBatch === 0 ? '0 (pilot)' : r.currentBatch}</Fact>
              <Fact label="Failure threshold">{r.failureThreshold === 0 ? 'Never pause' : `${failed} / ${r.failureThreshold} failed`}</Fact>
              <Fact label="Created">{formatDate(r.createdAt)}</Fact>
              <Fact label="Started">{formatDate(r.startedAt)}</Fact>
              <Fact label={r.status === 'CANCELED' ? 'Canceled' : 'Completed'}>{formatDate(r.status === 'CANCELED' ? r.canceledAt : r.completedAt)}</Fact>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Settings</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <Fact label="Pilot group">{r.pilotGroup?.name ?? 'None'}</Fact>
              <Fact label="Batch size">{r.batchSize}</Fact>
              <Fact label="Attempts / backoff">{r.maxAttempts} attempts, {r.backoffMinutes} min backoff (doubling)</Fact>
              <Fact label="Verify timeout">{r.verifyTimeoutMinutes} min</Fact>
              <Fact label="Maintenance window">
                {r.maintenanceWindow
                  ? <>
                      {r.maintenanceWindow.timeZone}
                      {r.maintenanceWindow.windows.map((w, i) => (
                        <span key={i} className="block text-xs text-muted-foreground">
                          {w.days.map((d) => DAYS[d]).join(', ')} {w.start}–{w.end}
                        </span>
                      ))}
                    </>
                  : 'Any time'}
              </Fact>
              <Fact label="Unknown session state">{r.deferOnUnknownSession ? 'Defer' : 'Proceed'}</Fact>
              {r.component === 'RUSTDESK' && (
                <Fact label="Installer">
                  <span className="font-mono text-xs break-all">{r.artifactName}</span>
                  <span className="block text-xs text-muted-foreground break-all">
                    {r.artifactSha256
                      ? <>SHA-256 pinned: <span className="font-mono">{r.artifactSha256}</span></>
                      : 'No digest pinned (signature-only): the installer requires a valid Authenticode signature.'}
                  </span>
                </Fact>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        {batches.map(([batch, jobs]) => {
          const tally = jobs.reduce<Partial<Record<JobStatus, number>>>((acc, j) => ({ ...acc, [j.status]: (acc[j.status] ?? 0) + 1 }), {});
          return (
            <Card key={batch}>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {batch === 0 ? 'Batch 0 — pilot' : `Batch ${batch}`}
                  <span className="text-xs font-normal text-muted-foreground">
                    {jobs.length} computer{jobs.length === 1 ? '' : 's'}
                    {r.status !== 'DRAFT' && (released(batch) ? ' · released' : ' · not released yet')}
                    {r.status !== 'DRAFT' && batch === r.currentBatch && ' · current'}
                  </span>
                </CardTitle>
                <CardDescription>
                  {STATUS_ORDER.filter((s) => tally[s]).map((s) => `${tally[s]} ${JOB_LABEL[s].toLowerCase()}`).join(' · ')}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 pb-2">
                <ul className="divide-y border-t">
                  {jobs.map((j) => <JobItem key={j.id} job={j} maxAttempts={r.maxAttempts} onCancel={setCancelJob} />)}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Rollback is not offered. If an update leaves a computer unusable, follow the recovery steps in
        {' '}<Link href="/docs/updates" className="underline">Updates</Link>.
      </p>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this rollout?"
        description={
          'Jobs that have not been sent yet will stop. Jobs already dispatched cannot be recalled — the installer may already be running on those computers, ' +
          'so they are marked canceled and may still finish installing. This cannot be undone; create a new rollout to continue later.'
        }
        confirmLabel="Cancel rollout"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
      <ConfirmDialog
        open={!!cancelJob}
        onOpenChange={(o) => { if (!o) setCancelJob(null); }}
        title={`Cancel the job for ${cancelJob?.endpoint?.name ?? 'this computer'}?`}
        description={
          cancelJob && cancelJob.status !== 'REQUESTED'
            ? 'This job has already been dispatched. Canceling stops tracking it, but cannot recall the update: the installer may still run on the computer.'
            : 'The update will not be sent to this computer as part of this rollout.'
        }
        confirmLabel="Cancel job"
        destructive
        loading={cancelOne.isPending}
        onConfirm={() => cancelJob && cancelOne.mutate(cancelJob.id)}
      />
    </div>
  );
}
