import { AccessPolicyService } from '../security-controls/access-policy.service';
import { AbuseGuardService } from '../security-controls/abuse-guard.service';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JobRequest, MAX_JOB_TTL_S, type DelegationClaims } from './contract';
import { canonicalJson, sha256Hex } from './crypto';
import { DelegationService } from './delegation.service';
import { E, IntegrationError } from './errors';
import type { Peer } from './peers';
import { ReplayGuardService } from './replay-guard.service';
import { appendEvent, toJob } from './job-view';

/**
 * Intake and read side of contract ticket-rmm-v1. Runs in the API process.
 * It never calls the inference gateway and never runs an analysis — that is
 * the worker's job — so a request thread cannot be held open by a model.
 */
@Injectable()
export class IntegrationJobsService {
  private readonly logger = new Logger('IntegrationJobs');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly delegation: DelegationService,
    private readonly replay: ReplayGuardService,
    private readonly policy: AccessPolicyService,
    private readonly abuse: AbuseGuardService,
  ) {}

  /**
   * Submit. Order matters:
   *   validate → hash → verify delegation (bound to that hash) → actor binding
   *   → idempotency → live access → policy → consume jti → create.
   * Idempotent replays come back as `{ replayed: true }` (HTTP 200) with the
   * ORIGINAL job; the same key with a different payload is 409 whoever asks.
   */
  async submit(peer: Peer, rawBody: unknown, token: string | undefined): Promise<{ replayed: boolean; job: ReturnType<typeof toJob> }> {
    const parsed = JobRequest.safeParse(rawBody);
    if (!parsed.success) {
      const where = parsed.error.issues.slice(0, 5).map((i) => i.path.join('.') || '(root)').join(', ');
      throw E.invalid(`Request does not match job-request schema at: ${where}`);
    }
    const body = parsed.data;
    const payloadSha256 = sha256Hex(canonicalJson(body));
    const claims = this.delegation.verifyToken(peer, token, 'ticket_analysis:submit', payloadSha256);

    // The body names the actor and organization explicitly; they must be the
    // ones the delegation token vouches for. A forged technician_id in a
    // validly signed request is refused here.
    if (claims.org !== body.organization_id || claims.sub !== body.technician_id) {
      await this.reject(peer, claims, 'ACTOR_MISMATCH');
      throw E.forbidden('organization_id / technician_id do not match the delegation token');
    }

    const existing = await this.prisma.integrationJob.findUnique({
      where: { peerId_idempotencyKey: { peerId: peer.id, idempotencyKey: body.idempotency_key } },
      include: { runs: true },
    });
    if (existing) return this.replayOf(peer, claims, existing, payloadSha256);

    // A jti already spent on a different request is a replay. (One spent on
    // THIS request is handled above: the job exists.)
    const spent = await this.replay.lookup(this.delegation.jtiKey(peer, claims));
    if (spent) throw E.replay('Delegation token already used');

    const who = await this.delegation.requireActor(peer.id, claims).catch(async (e) => {
      await this.reject(peer, claims, 'NO_ACCESS');
      throw e;
    });

    const notAllowed = body.model_profiles.filter((p) => !peer.modelProfiles.includes(p));
    if (notAllowed.length) throw E.invalid(`Model profile not offered: ${notAllowed.join(', ')}`);

    const expiresAt = new Date(body.expires_at);
    const now = Date.now();
    if (expiresAt.getTime() < now + 60_000) throw E.invalid('expires_at must be at least 60 seconds ahead');
    if (expiresAt.getTime() > now + MAX_JOB_TTL_S * 1000) throw E.invalid(`expires_at must be within ${MAX_JOB_TTL_S} seconds`);

    let endpointId: string | null = null;
    if (body.endpoint) endpointId = (await this.delegation.assertEndpoint(who.actor, body.endpoint.rem0te_endpoint_id)).id;

    // Fleet limits (v0.23): analysis reads endpoint evidence, so it counts —
    // against the delegated technician (the same counter as their UI and
    // launcher work, so a split across entry points still adds up) and
    // against the peer as a whole. Idempotent replays returned above are not
    // counted twice.
    for (const [identity, tier] of [[`user:${who.actor.userId}`, this.policy.tierFor(who.actor, endpointId)], [`peer:${peer.id}`, 'integration']] as const) {
      const r = await this.abuse.admit({ identity, tier, kind: 'EVIDENCE', endpointId, customerId: who.customerId, entryPoint: 'integration' });
      if (!r.ok) {
        await this.reject(peer, claims, r.reason === 'identity_paused' ? 'IDENTITY_PAUSED' : 'THRESHOLD_TRIPPED');
        throw new IntegrationError(403, r.reason === 'identity_paused' ? 'IDENTITY_PAUSED' : 'THRESHOLD_TRIPPED', r.message);
      }
    }

    const jobId = randomUUID();
    if (!(await this.replay.consume(this.delegation.jtiKey(peer, claims), this.delegation.jtiExpiry(claims), jobId))) {
      throw E.replay('Delegation token already used');
    }

    try {
      const job = await this.prisma.$transaction(async (tx) => {
        await tx.integrationJob.create({
          data: {
            id: jobId, peerId: peer.id, tenantId: who.tenantId, customerId: who.customerId,
            actorUserId: who.actor.userId, externalOrgId: body.organization_id, externalTechnicianId: body.technician_id,
            ticketId: body.ticket.id, ticketRevision: body.ticket.revision, endpointId,
            modelProfiles: body.model_profiles, correlationId: body.correlation_id,
            idempotencyKey: body.idempotency_key, payloadSha256,
            input: { ticket: body.ticket, evidence: body.evidence } as unknown as Prisma.InputJsonValue,
            expiresAt,
            runs: { create: body.model_profiles.map((p) => ({ modelProfile: p })) },
          },
        });
        await appendEvent(tx, jobId, 'job.accepted');
        return tx.integrationJob.findUniqueOrThrow({ where: { id: jobId }, include: { runs: true } });
      });
      await this.audit.log({
        action: 'INTEGRATION_JOB_ACCEPTED', tenantId: who.tenantId, customerId: who.customerId, actorId: who.actor.userId,
        resource: 'integration_job', resourceId: jobId,
        meta: { peer: peer.id, ticket: `${body.ticket.id}@${body.ticket.revision}`, profiles: body.model_profiles, endpointId, correlationId: body.correlation_id },
      });
      return { replayed: false, job: toJob(job) };
    } catch (e) {
      // Two concurrent submits with the same key: the loser reads the winner.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.integrationJob.findUnique({
          where: { peerId_idempotencyKey: { peerId: peer.id, idempotencyKey: body.idempotency_key } }, include: { runs: true },
        });
        if (winner) {
          if (winner.payloadSha256 !== payloadSha256) throw E.idempotencyConflict();
          return { replayed: true, job: toJob(winner) };
        }
      }
      throw e;
    }
  }

  private async replayOf(peer: Peer, claims: DelegationClaims, existing: Parameters<typeof toJob>[0], payloadSha256: string) {
    if (existing.payloadSha256 !== payloadSha256) throw E.idempotencyConflict();
    // Identical payload ⇒ identical org and technician. Still: the findings
    // are staff-only, so only someone with access NOW may see them again.
    await this.delegation.requireActor(peer.id, claims);
    return { replayed: true, job: toJob(existing) };
  }

  private async scopedJob(peer: Peer, jobId: string, token: string | undefined) {
    const claims = this.delegation.verifyToken(peer, token, 'ticket_analysis:read');
    await this.delegation.consumeReadToken(peer, claims);
    const who = await this.delegation.requireActor(peer.id, claims);
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw E.notFound();
    const job = await this.prisma.integrationJob.findUnique({ where: { id: jobId }, include: { runs: true } });
    // Another peer's job, another organization's job and a job that does not
    // exist are indistinguishable.
    if (!job || job.peerId !== peer.id || job.externalOrgId !== claims.org || job.customerId !== who.customerId) throw E.notFound();
    return job;
  }

  async get(peer: Peer, jobId: string, token: string | undefined) {
    return toJob(await this.scopedJob(peer, jobId, token));
  }

  async events(peer: Peer, jobId: string, after: number, token: string | undefined) {
    const job = await this.scopedJob(peer, jobId, token);
    const rows = await this.prisma.integrationEvent.findMany({
      where: { jobId: job.id, sequence: { gt: Math.max(0, after) } }, orderBy: { sequence: 'asc' }, take: 100,
    });
    return {
      job_id: job.id,
      last_event_sequence: job.lastEventSequence,
      events: rows.map((r) => ({ event: r.body, signature: { alg: 'Ed25519', kid: r.keyId, sig: r.signature } })),
    };
  }

  private async reject(peer: Peer, claims: DelegationClaims, reason: string) {
    const org = await this.prisma.integrationOrgMapping.findUnique({
      where: { peerId_externalOrgId: { peerId: peer.id, externalOrgId: claims.org } },
    }).catch(() => null);
    await this.audit.log({
      action: 'INTEGRATION_JOB_REJECTED', tenantId: org?.tenantId, customerId: org?.customerId,
      resource: 'integration_job', meta: { peer: peer.id, org: claims.org, technician: claims.sub, reason },
    });
  }
}
