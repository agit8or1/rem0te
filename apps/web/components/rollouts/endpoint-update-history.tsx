'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { rolloutsApi } from '@/lib/api-client';
import { formatDate, cn } from '@/lib/utils';
import { ChevronDown, ChevronRight } from 'lucide-react';

// ─── Shapes (apps/api/src/admin/update-rollout.service.ts) ──────────────────

export type RolloutStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELED';
export type JobStatus =
  | 'REQUESTED' | 'DISPATCHED' | 'INSTALLING' | 'AWAITING_VERIFICATION'
  | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'SKIPPED';

export const JOB_DONE: JobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED'];

export interface JobEvent {
  id: string; event: string; status: JobStatus | null;
  detail: Record<string, unknown> | null; createdAt: string;
}

export interface UpdateJob {
  id: string; rolloutId: string; endpointId: string; customerId: string | null; batch: number;
  status: JobStatus; attempts: number; nextAttemptAt: string | null; dispatchedAt: string | null;
  installStartedAt: string | null; verifiedAt: string | null; completedAt: string | null;
  fromVersion: string | null; installedVersion: string | null; failureReason: string | null;
  deferReason: string | null; credentialSync: string | null; createdAt: string; updatedAt: string;
  events: JobEvent[];
}

// ─── Badges ─────────────────────────────────────────────────────────────────

const pill = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';

const ROLLOUT_STYLE: Record<RolloutStatus, string> = {
  DRAFT: 'border-transparent bg-muted text-muted-foreground',
  RUNNING: 'border-transparent bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  PAUSED: 'border-transparent bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200',
  COMPLETED: 'border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  CANCELED: 'border-transparent bg-muted text-muted-foreground line-through',
};

export function RolloutStatusBadge({ status }: { status: RolloutStatus }) {
  return <span className={cn(pill, ROLLOUT_STYLE[status] ?? ROLLOUT_STYLE.DRAFT)}>{status.toLowerCase()}</span>;
}

const JOB_STYLE: Record<JobStatus, string> = {
  REQUESTED: 'border-transparent bg-muted text-muted-foreground',
  DISPATCHED: 'border-transparent bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  INSTALLING: 'border-transparent bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  AWAITING_VERIFICATION: 'border-transparent bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  SUCCEEDED: 'border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  FAILED: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  CANCELED: 'border-transparent bg-muted text-muted-foreground',
  SKIPPED: 'bg-transparent text-muted-foreground',
};

export const JOB_LABEL: Record<JobStatus, string> = {
  REQUESTED: 'Waiting',
  DISPATCHED: 'Dispatched',
  INSTALLING: 'Installing',
  AWAITING_VERIFICATION: 'Awaiting verification',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
  SKIPPED: 'Skipped',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <span className={cn(pill, JOB_STYLE[status] ?? JOB_STYLE.REQUESTED)}>{JOB_LABEL[status] ?? status}</span>;
}

/**
 * The success event's registration verdict. "unavailable" means the hbbs
 * presence query could not be made, so the job succeeded on version +
 * authenticated heartbeat alone and registration was NOT independently checked.
 */
export function registrationOf(job: Pick<UpdateJob, 'events'>): string | null {
  const v = [...job.events].reverse().find((e) => e.event === 'verified');
  const r = v?.detail?.registration;
  return typeof r === 'string' ? r : null;
}

export function RegistrationNote({ job }: { job: Pick<UpdateJob, 'events' | 'status'> }) {
  if (job.status !== 'SUCCEEDED') return null;
  const r = registrationOf(job);
  if (r === 'unavailable') {
    return (
      <span className={cn(pill, 'border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200')}
        title="The RustDesk server's presence check could not be queried, so registration was not independently verified.">
        registration not verified
      </span>
    );
  }
  if (r === 'registered') return <span className="text-xs text-muted-foreground">registered with hbbs</span>;
  return null;
}

// ─── Events ─────────────────────────────────────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  dispatched: 'Update handed to the computer in a heartbeat response',
  installer_fetched: 'Computer fetched the installer',
  version_reported: 'Authenticated heartbeat reported the approved version',
  verified: 'Verified',
  deferred: 'Deferred',
  retry_scheduled: 'Attempt failed; retry scheduled',
  failed: 'Failed',
  canceled: 'Canceled',
};

function describe(e: JobEvent): string {
  const d = e.detail ?? {};
  const s = (k: string) => (d[k] === undefined || d[k] === null ? null : String(d[k]));
  switch (e.event) {
    case 'dispatched':
      return [s('attempt') && `attempt ${s('attempt')}`, s('targetVersion') && `target ${s('targetVersion')}`].filter(Boolean).join(', ');
    case 'version_reported':
      return [s('reported') && `reported ${s('reported')}`, d.nonceEchoed === true ? 'job nonce echoed' : d.nonceEchoed === false ? 'job nonce not echoed' : null]
        .filter(Boolean).join(', ');
    case 'verified': {
      const reg = s('registration');
      const regText = reg === 'registered'
        ? 'registered with the RustDesk server (hbbs)'
        : reg === 'unavailable'
          ? 'registration NOT independently verified — the hbbs presence check was unavailable'
          : reg ? `registration: ${reg}` : null;
      return [s('installedVersion') && `installed ${s('installedVersion')}`, 'authenticated heartbeat', regText].filter(Boolean).join('; ');
    }
    case 'deferred':
      return s('reason') ?? '';
    case 'retry_scheduled':
      return [s('reason'), s('retryInMinutes') && `retry in ${s('retryInMinutes')} min`].filter(Boolean).join('; ');
    case 'failed':
      return [s('reason'), s('attempts') && `after ${s('attempts')} attempt(s)`].filter(Boolean).join('; ');
    case 'canceled':
      return s('previous') ? `was ${s('previous')?.toLowerCase()}` : '';
    default:
      return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}

export function JobEventList({ events }: { events: JobEvent[] }) {
  if (!events.length) return <p className="text-xs text-muted-foreground">No events recorded yet.</p>;
  return (
    <ol className="space-y-1 border-l pl-3">
      {events.map((e) => {
        const text = describe(e);
        return (
          <li key={e.id} className="text-xs">
            <span className="text-muted-foreground tabular-nums">{formatDate(e.createdAt)}</span>
            {' · '}
            <span className="font-medium">{EVENT_LABEL[e.event] ?? e.event}</span>
            {text && <span className="text-muted-foreground"> — {text}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Per-computer history ───────────────────────────────────────────────────

interface HistoryRow extends UpdateJob {
  rollout: { id: string; name: string; component: 'RUSTDESK' | 'AGENT'; targetVersion: string; status: RolloutStatus };
}

/**
 * Staged-update history for one computer (latest 20 jobs). Platform Admin
 * only on the API side; for anyone else the request 403s and this renders
 * nothing.
 */
export function EndpointUpdateHistory({ endpointId }: { endpointId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery<HistoryRow[]>({
    queryKey: ['rollout-history', endpointId],
    queryFn: () => rolloutsApi.history(endpointId).then((r) => r.data?.data ?? []),
    retry: false,
  });

  if (isError) return null;
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading update history…</p>;
  if (!data?.length) return <p className="text-sm text-muted-foreground">This computer has not been part of a staged update.</p>;

  return (
    <ul className="divide-y rounded-md border">
      {data.map((j) => {
        const expanded = open === j.id;
        return (
          <li key={j.id} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={expanded ? 'Hide events' : 'Show events'}
                onClick={() => setOpen(expanded ? null : j.id)}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              <Link href={`/admin/rollouts/${j.rollout.id}`} className="font-medium hover:underline">{j.rollout.name}</Link>
              <span className="text-xs text-muted-foreground">
                {j.rollout.component === 'RUSTDESK' ? 'RustDesk' : 'Agent'} {j.fromVersion ?? '?'} → {j.rollout.targetVersion}
              </span>
              <JobStatusBadge status={j.status} />
              <RegistrationNote job={j} />
              <span className="ml-auto text-xs text-muted-foreground">{formatDate(j.completedAt ?? j.updatedAt)}</span>
            </div>
            {(j.failureReason || j.deferReason) && (
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
                {j.failureReason ? `${j.status === 'SKIPPED' ? 'Skipped' : 'Reason'}: ${j.failureReason}` : `Deferred: ${j.deferReason}`}
              </p>
            )}
            {expanded && <div className="mt-2 pl-6"><JobEventList events={j.events} /></div>}
          </li>
        );
      })}
    </ul>
  );
}
