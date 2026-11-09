import type { IntegrationJob, IntegrationJobRun, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CONTRACT, type Event, type Job, type AnalysisResult } from './contract';
import { signEvent } from './signer';

export type JobRow = IntegrationJob & { runs: IntegrationJobRun[] };

export function toJob(j: JobRow): Job {
  return {
    contract: CONTRACT,
    job_id: j.id,
    status: j.status.toLowerCase() as Job['status'],
    organization_id: j.externalOrgId,
    technician_id: j.externalTechnicianId,
    ticket: { id: j.ticketId, revision: j.ticketRevision },
    endpoint_id: j.endpointId,
    model_profiles: j.modelProfiles,
    correlation_id: j.correlationId,
    idempotency_key: j.idempotencyKey,
    payload_sha256: j.payloadSha256,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
    expires_at: j.expiresAt.toISOString(),
    completed_at: j.completedAt ? j.completedAt.toISOString() : null,
    last_event_sequence: j.lastEventSequence,
    runs: j.modelProfiles.map((p) => {
      const r = j.runs.find((x) => x.modelProfile === p);
      return { model_profile: p, status: (r?.status ?? 'PENDING').toLowerCase() as 'pending' | 'succeeded' | 'failed', error_code: r?.errorCode ?? null };
    }),
    error: j.errorCode ? { code: j.errorCode, message: j.errorMessage ?? '' } : null,
    result: (j.result as unknown as AnalysisResult | null) ?? null,
  };
}

export const EVENT_FOR_STATUS = {
  QUEUED: 'job.accepted', RUNNING: 'job.running', SUCCEEDED: 'job.succeeded',
  PARTIAL: 'job.partial', FAILED: 'job.failed', EXPIRED: 'job.expired',
} as const;

/**
 * Append the next signed event for a job, inside the caller's transaction.
 * The sequence comes from an atomic increment on the job row, so two writers
 * can never hand out the same number, and the event carries a snapshot of
 * the job as of that write.
 */
export async function appendEvent(tx: Prisma.TransactionClient, jobId: string, type: Event['type']) {
  const job = await tx.integrationJob.update({
    where: { id: jobId },
    data: { lastEventSequence: { increment: 1 } },
    include: { runs: true },
  });
  const event: Event = {
    contract: CONTRACT,
    event_id: randomUUID(),
    sequence: job.lastEventSequence,
    type,
    occurred_at: new Date().toISOString(),
    peer_id: job.peerId,
    organization_id: job.externalOrgId,
    job_id: job.id,
    correlation_id: job.correlationId,
    job: toJob(job),
  };
  const signature = signEvent(event);
  await tx.integrationEvent.create({
    data: {
      id: event.event_id, jobId: job.id, peerId: job.peerId, sequence: event.sequence, type,
      body: event as unknown as Prisma.InputJsonValue, signature: signature.sig, keyId: signature.kid,
    },
  });
  return event;
}
