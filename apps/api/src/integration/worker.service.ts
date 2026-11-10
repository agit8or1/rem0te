/**
 * The analysis worker. Durable: all state is in Postgres, work is claimed
 * with a lease (FOR UPDATE SKIP LOCKED), a worker that dies mid-job loses its
 * lease and the job is picked up again, and per-profile results already
 * bought are not bought twice.
 *
 * What this file may touch is pinned by scripts/check-security-invariants.mjs:
 * no process spawning, no sessions/launcher/connection grants, no endpoint
 * command queue, no fetch other than signer.signedPost to a peer-file URL.
 * It reads tickets and a bounded endpoint snapshot; it writes jobs, runs and
 * events. It cannot run a shell, fetch an arbitrary URL, open a session or
 * approve anything, because none of those is reachable from here.
 */
import { activePause } from '../containment/pause';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IntegrationJobStatus, Prisma } from '@prisma/client';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DelegationService } from './delegation.service';
import { loadTrust, type Peer } from './peers';
import { aggregate, endpointEvidence, injectionFlags, ticketSegments, type EvidenceItem, type ParsedRun, type Segment } from './analysis';
import { infer, GatewayError } from './gateway.client';
import { appendEvent, EVENT_FOR_STATUS } from './job-view';
import { signedPost } from './signer';
import type { JobRequest } from './contract';

const LEASE_MS = Number(process.env.INTEGRATION_LEASE_MS ?? 3 * 60_000);
const MAX_JOB_ATTEMPTS = 5;
const MAX_RUN_ATTEMPTS = 3;
const EVENT_GIVE_UP_MS = 7 * 24 * 3600_000;

@Injectable()
export class IntegrationWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger('IntegrationWorker');
  readonly id = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly delegation: DelegationService,
  ) {}

  start(intervalMs = 1000) {
    if (!loadTrust()) { this.logger.warn('INTEGRATION_PEERS_FILE not set — worker idle'); return; }
    this.logger.log(`worker ${this.id} started`);
    const loop = async () => {
      if (this.stopping) return;
      if (!this.busy) {
        this.busy = true;
        try { await this.tick(); } catch (e) { this.logger.error(`tick failed: ${(e as Error).message}`); }
        this.busy = false;
      }
      this.timer = setTimeout(loop, intervalMs);
    };
    this.timer = setTimeout(loop, 10);
  }

  onModuleDestroy() { this.stopping = true; if (this.timer) clearTimeout(this.timer); }

  async tick() {
    for (let i = 0; i < 5; i++) { const id = await this.claim(); if (!id) break; await this.process(id); }
    await this.deliverEvents();
  }

  /** Claim one due job, or one whose lease lapsed. */
  async claim(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "IntegrationJob" SET "status" = 'RUNNING', "leaseOwner" = ${this.id},
             "leaseExpiresAt" = now() + (${LEASE_MS} * interval '1 millisecond'),
             "attempts" = "attempts" + 1, "updatedAt" = now()
       WHERE "id" = (
         SELECT "id" FROM "IntegrationJob"
          WHERE ("status" = 'QUEUED' AND "nextAttemptAt" <= now())
             OR ("status" = 'RUNNING' AND "leaseExpiresAt" < now())
          ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  private async renewLease(jobId: string): Promise<boolean> {
    const r = await this.prisma.integrationJob.updateMany({
      where: { id: jobId, leaseOwner: this.id, status: 'RUNNING' },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
    return r.count === 1;
  }

  async process(jobId: string) {
    const job = await this.prisma.integrationJob.findUnique({ where: { id: jobId }, include: { runs: true } });
    if (!job || job.leaseOwner !== this.id) return;
    const peer = loadTrust()?.peers.get(job.peerId);
    if (!peer) return this.finish(jobId, 'FAILED', null, 'PEER_REMOVED', 'Peer is no longer configured');
    if (job.expiresAt < new Date()) return this.finish(jobId, 'EXPIRED', null, 'EXPIRED', 'Job expired before it completed');

    const access = await this.delegation.checkActor(job.peerId, job.externalOrgId, job.externalTechnicianId);
    if (!access.ok || access.customerId !== job.customerId) {
      return this.finish(jobId, 'FAILED', null, 'ACTOR_REVOKED', access.ok ? 'Mapping now points at a different business' : access.message);
    }
    // v0.28: a job queued before a pause does not run under one.
    if (await activePause(this.prisma, 'integration', job.customerId)) {
      return this.finish(jobId, 'FAILED', null, 'CONTAINED', 'Integration jobs are paused for this business; submit again once the pause is lifted.');
    }
    if (job.attempts === 1) await this.prisma.$transaction((tx) => appendEvent(tx, jobId, 'job.running'));

    const input = job.input as unknown as { ticket: JobRequest['ticket']; evidence: JobRequest['evidence'] };
    const segments: Segment[] = ticketSegments(input.ticket);
    const evidence: EvidenceItem[] = segments.map((s) => ({ ref: s.ref, kind: s.kind, summary: `${s.kind}${s.author_role ? ` (${s.author_role})` : ''}, ${s.text.length} chars`, observed_at: null }));
    const observedFacts: { statement: string; evidence_refs: string[] }[] = [];
    if (job.endpointId) {
      try {
        await this.delegation.assertEndpoint(access.actor, job.endpointId);
      } catch {
        return this.finish(jobId, 'FAILED', null, 'ENDPOINT_NOT_AVAILABLE', 'Endpoint is no longer in scope for this technician');
      }
      if (input.evidence?.include_endpoint_inventory) {
        const ep = await this.prisma.endpoint.findUnique({
          where: { id: job.endpointId },
          select: {
            id: true, name: true, platform: true, agentVersion: true, isOnline: true, lastSeenAt: true,
            inventory: { select: {
              collectedAt: true, osCaption: true, osBuild: true, lastBootAt: true, uptimeSeconds: true,
              memoryTotalMb: true, memoryFreeMb: true, systemDiskTotalMb: true, systemDiskFreeMb: true, liveSampledAt: true,
              pendingUpdateCount: true, rebootRequired: true, updatesCheckedAt: true,
            } },
          },
        });
        if (ep) {
          const ev = endpointEvidence(ep, new Date());
          segments.push(...ev.segments);
          evidence.push(...ev.evidence);
          for (const e of ev.evidence) observedFacts.push({ statement: e.summary, evidence_refs: [e.ref] });
        }
      }
    }
    const refs = segments.map((s) => s.ref);
    const flags = injectionFlags(segments.filter((s) => s.author_role !== 'rem0te'));

    let transientPending = false;
    for (const profile of job.modelProfiles) {
      const run = job.runs.find((r) => r.modelProfile === profile);
      if (!run || run.status !== 'PENDING') continue;
      // Re-check before every paid call: a role revoked mid-job stops the job here.
      const still = await this.delegation.checkActor(job.peerId, job.externalOrgId, job.externalTechnicianId);
      if (!still.ok) return this.finish(jobId, 'FAILED', null, 'ACTOR_REVOKED', still.message);
      if (!(await this.renewLease(jobId))) return; // someone else owns it now
      try {
        const r = await infer(peer, job, profile, segments, refs);
        await this.prisma.integrationJobRun.update({
          where: { id: run.id },
          data: {
            status: r.ok ? 'SUCCEEDED' : 'FAILED', attempts: { increment: 1 }, requestId: r.requestId,
            resolvedModel: r.resolved_model, latencyMs: r.latencyMs,
            output: r.output ? (r.output as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            // The dropped-field count rides with usage so the aggregate step can report it.
            usage: (r.usage || r.dropped_unknown_fields)
              ? ({ ...(r.usage ?? {}), dropped_unknown_fields: r.dropped_unknown_fields } as Prisma.InputJsonValue)
              : Prisma.DbNull,
            errorCode: r.error?.code ?? null, errorMessage: r.error?.message ?? null,
          },
        });
      } catch (e) {
        const ge = e instanceof GatewayError ? e : new GatewayError('INTERNAL', 'unexpected error', true);
        const attempts = run.attempts + 1;
        const giveUp = !ge.transient || attempts >= MAX_RUN_ATTEMPTS;
        await this.prisma.integrationJobRun.update({
          where: { id: run.id },
          data: { attempts, status: giveUp ? 'FAILED' : 'PENDING', errorCode: ge.code, errorMessage: ge.message.slice(0, 300) },
        });
        if (!giveUp) transientPending = true;
        this.logger.warn(`job ${jobId} profile ${profile}: ${ge.code}${giveUp ? '' : ' (will retry)'}`);
      }
    }

    if (transientPending && job.attempts < MAX_JOB_ATTEMPTS) {
      const delay = Math.min(60_000, 2000 * 2 ** job.attempts);
      await this.prisma.integrationJob.updateMany({
        where: { id: jobId, leaseOwner: this.id },
        data: { status: 'QUEUED', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + delay) },
      });
      return;
    }
    if (transientPending) {
      await this.prisma.integrationJobRun.updateMany({ where: { jobId, status: 'PENDING' }, data: { status: 'FAILED' } });
    }

    const runs = await this.prisma.integrationJobRun.findMany({ where: { jobId } });
    const parsed: ParsedRun[] = job.modelProfiles.map((p) => {
      const r = runs.find((x) => x.modelProfile === p)!;
      const usage = r.usage as { input_tokens?: number; output_tokens?: number; dropped_unknown_fields?: number } | null;
      return {
        model_profile: p, resolved_model: r.resolvedModel, ok: r.status === 'SUCCEEDED',
        output: r.status === 'SUCCEEDED' ? (r.output as never) : null,
        dropped_unknown_fields: usage?.dropped_unknown_fields ?? 0,
        usage: usage && typeof usage.input_tokens === 'number' ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens ?? 0 } : null,
        error: r.status === 'SUCCEEDED' ? undefined : { code: r.errorCode ?? 'FAILED', message: r.errorMessage ?? 'failed' },
      };
    });
    const succeeded = parsed.filter((r) => r.ok).length;
    const result = aggregate({ runs: parsed, knownRefs: new Set(refs), evidence, flags, observedFacts });
    const status: IntegrationJobStatus = succeeded === parsed.length ? 'SUCCEEDED' : succeeded > 0 ? 'PARTIAL' : 'FAILED';
    return this.finish(jobId, status, result, status === 'FAILED' ? 'ALL_PROFILES_FAILED' : null, status === 'FAILED' ? 'Every model profile failed' : null);
  }

  /** Terminal write + event, only while we still hold the lease. */
  private async finish(jobId: string, status: IntegrationJobStatus, result: unknown, code: string | null, message: string | null) {
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.integrationJob.updateMany({
        where: { id: jobId, leaseOwner: this.id, status: 'RUNNING' },
        data: {
          status, result: result ? (result as Prisma.InputJsonValue) : Prisma.DbNull,
          errorCode: code, errorMessage: message, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null,
        },
      });
      if (r.count !== 1) return null;
      await appendEvent(tx, jobId, EVENT_FOR_STATUS[status] as never);
      return tx.integrationJob.findUnique({ where: { id: jobId } });
    });
    if (done) {
      await this.audit.log({
        action: 'INTEGRATION_JOB_FINISHED', tenantId: done.tenantId, customerId: done.customerId, actorId: done.actorUserId,
        resource: 'integration_job', resourceId: jobId, meta: { status, code },
      });
    }
  }

  /**
   * Push undelivered events. A 2xx is the acknowledgement; anything else is
   * retried with backoff. The peer de-duplicates by event_id and orders by
   * sequence, and can always recover by polling — so a lost ack costs a
   * duplicate delivery, never a lost result.
   */
  async deliverEvents() {
    const trust = loadTrust();
    if (!trust) return;
    const due = await this.prisma.integrationEvent.findMany({
      where: { ackedAt: null, nextDeliveryAt: { lte: new Date() } }, orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }], take: 20,
    });
    for (const ev of due) {
      const peer: Peer | undefined = trust.peers.get(ev.peerId);
      if (!peer) continue;
      if (Date.now() - ev.createdAt.getTime() > EVENT_GIVE_UP_MS) {
        await this.prisma.integrationEvent.update({ where: { id: ev.id }, data: { nextDeliveryAt: new Date(8640000000000000), lastDeliveryError: 'gave up; recover by polling' } });
        continue;
      }
      let error: string | null = null;
      try {
        const r = await signedPost(peer, 'events', JSON.stringify({ event: ev.body, signature: { alg: 'Ed25519', kid: ev.keyId, sig: ev.signature } }), 10_000, 16 * 1024);
        if (r.status < 200 || r.status >= 300) error = `HTTP ${r.status}`;
      } catch (e) { error = (e as Error).name || 'network error'; }
      const attempts = ev.deliveryAttempts + 1;
      await this.prisma.integrationEvent.update({
        where: { id: ev.id },
        data: error
          ? { deliveryAttempts: attempts, lastDeliveryError: error, nextDeliveryAt: new Date(Date.now() + Math.min(3600_000, 2000 * 2 ** attempts)) }
          : { deliveryAttempts: attempts, ackedAt: new Date(), lastDeliveryError: null },
      });
    }
    await this.deliverAlertEvents(trust);
  }

  /**
   * Monitoring alert events (v0.29), to the same events URL, under their own
   * envelope key (`alert_event`) and signing prefix. Same rules: 2xx is the
   * ack, anything else backs off, and the peer recovers by polling
   * GET /api/integration/v1/alerts/events.
   */
  private async deliverAlertEvents(trust: NonNullable<ReturnType<typeof loadTrust>>) {
    const due = await this.prisma.integrationAlertEvent.findMany({
      where: { ackedAt: null, nextDeliveryAt: { lte: new Date() } }, orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }], take: 20,
    });
    for (const ev of due) {
      const peer: Peer | undefined = trust.peers.get(ev.peerId);
      if (!peer) continue;
      if (Date.now() - ev.createdAt.getTime() > EVENT_GIVE_UP_MS) {
        await this.prisma.integrationAlertEvent.update({ where: { id: ev.id }, data: { nextDeliveryAt: new Date(8640000000000000), lastDeliveryError: 'gave up; recover by polling' } });
        continue;
      }
      let error: string | null = null;
      try {
        const r = await signedPost(peer, 'events', JSON.stringify({ alert_event: ev.body, signature: { alg: 'Ed25519', kid: ev.keyId, sig: ev.signature } }), 10_000, 16 * 1024);
        if (r.status < 200 || r.status >= 300) error = `HTTP ${r.status}`;
      } catch (e) { error = (e as Error).name || 'network error'; }
      const attempts = ev.deliveryAttempts + 1;
      await this.prisma.integrationAlertEvent.update({
        where: { id: ev.id },
        data: error
          ? { deliveryAttempts: attempts, lastDeliveryError: error, nextDeliveryAt: new Date(Date.now() + Math.min(3600_000, 2000 * 2 ** attempts)) }
          : { deliveryAttempts: attempts, ackedAt: new Date(), lastDeliveryError: null },
      });
    }
  }
}
