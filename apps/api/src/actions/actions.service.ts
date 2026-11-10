import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ActionJob, type ActionJobStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { AbuseGuardService } from '../security-controls/abuse-guard.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import {
  APPROVALS_REQUIRED, CATALOG, Envelope, MAX_WINDOW_HOURS, PLAN_SCHEMA, Plan, catalogEntry, planDigest,
} from './catalog';
import { SignerClient } from './signer.client';

/**
 * Approved actions, portal side (v0.26). The portal proposes, re-checks and
 * delivers; it cannot approve or sign. What it delivers is an envelope the
 * approval signer made, which the agent verifies against a key it learned
 * through the offline-rooted update chain.
 *
 * Lifecycle:
 *   AWAITING_APPROVAL ─signer quorum─▶ APPROVED ─heartbeat, rechecked─▶ DISPATCHED ─agent─▶ SUCCEEDED | FAILED | REFUSED_BY_ENDPOINT
 *        │                               │                                │
 *        ├▶ REJECTED / CANCELED / EXPIRED └▶ CANCELED (recheck failed)     └─ no result in 30 min ▶ UNKNOWN ─journal─▶ any of the above, or NOT_EXECUTED
 *
 * An UNKNOWN job keeps being offered: the agent answers from its journal and
 * never runs a job twice, so reconciliation is safe. A new job for the same
 * action on the same computer is refused until the last one is resolved.
 */

const UNRESOLVED: ActionJobStatus[] = ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED', 'UNKNOWN'];
const RESULT_DEADLINE_MS = 30 * 60_000;
const MAX_DELIVER = 3;

export const RequestDto = z.object({
  actionId: z.string().max(80),
  version: z.number().int().positive(),
  params: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(3).max(500),
  startsInMinutes: z.number().int().min(0).max(24 * 60).default(0),
  windowHours: z.number().int().min(1).max(MAX_WINDOW_HOURS).default(4),
}).strict();
export type RequestDto = z.infer<typeof RequestDto>;

export const ReconcileDto = z.object({
  found: z.enum(['running', 'stopped', 'other']),
  note: z.string().trim().min(3).max(500),
}).strict();

export const AgentResult = z.object({
  jobId: z.string().regex(/^[a-f0-9]{32}$/),
  outcome: z.enum(['succeeded', 'already_running', 'failed', 'refused', 'not_executed', 'uncertain']),
  reason: z.string().max(200).optional(),
  detail: z.string().max(500).optional(),
  observed: z.record(z.string(), z.string().max(40)).optional(),
  executedAt: z.string().max(40).optional(),
  agentSha256: z.string().max(64).optional(),
}).strict();

const STATUS_FOR: Record<z.infer<typeof AgentResult>['outcome'], ActionJobStatus> = {
  succeeded: 'SUCCEEDED', already_running: 'SUCCEEDED', failed: 'FAILED', refused: 'REFUSED_BY_ENDPOINT', not_executed: 'NOT_EXECUTED', uncertain: 'UNKNOWN',
};

@Injectable()
export class ActionsService {
  private readonly log = new Logger('Actions');
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly policy: AccessPolicyService,
    private readonly abuse: AbuseGuardService,
    private readonly updateTrust: UpdateTrustService,
    private readonly signer: SignerClient,
  ) {}

  catalog() {
    return {
      configured: this.signer.configured(),
      actions: CATALOG.map((a) => ({ id: a.id, version: a.version, title: a.title, description: a.description, warnings: a.warnings, verification: a.verification, doesNotProve: a.doesNotProve })),
    };
  }

  private async endpointFor(endpointId: string) {
    return this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: {
        id: true, name: true, hostname: true, tenantId: true, customerId: true, accessMode: true, deviceClass: true, status: true,
        updateChannel: true, agentActions: true, agentSha256: true,
        customer: { select: { id: true, name: true, isActive: true, isArchived: true } },
        rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } },
      },
    });
  }

  /** Why this computer cannot run the action yet, or null. Shown to the requester. */
  private readiness(ep: NonNullable<Awaited<ReturnType<ActionsService['endpointFor']>>>, key: string): string | null {
    if (!ep.rustdeskNode?.agentSecretHash || !ep.rustdeskNode.rustdeskId) return 'This computer has no enrolled device identity.';
    if (ep.updateChannel !== 'signed') return 'This computer runs a legacy agent. Migrate it to the signed agent first (docs/update-signing.md).';
    if (!ep.agentActions.includes(key)) return 'This computer\'s agent does not report support for this action. Update it to 0.26 or later.';
    const served = this.updateTrust.agentTarget();
    if (!served) return 'No signed agent build is published, so no plan can name one.';
    if (ep.agentSha256 !== served.sha256) return 'This computer\'s agent is not the currently published signed build; it would refuse the plan. Let it update first.';
    return null;
  }

  async request(actor: ActorContext, endpointId: string, raw: unknown, origin: { kind: 'technician' | 'ai_suggestion'; ticketRef: string | null; via: 'portal' | 'clientst0r' } = { kind: 'technician', ticketRef: null, via: 'portal' }, integration?: { peer: string; key: string }) {
    const parsed = RequestDto.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const dto = parsed.data;
    await this.acl.assertEndpointInScope(actor, endpointId);
    const ep = await this.endpointFor(endpointId);
    if (!ep || !ep.customerId || !ep.customer || ep.status === 'ARCHIVED') throw new NotFoundException('Computer not found');
    if (!ep.customer.isActive || ep.customer.isArchived) throw new NotFoundException('Computer not found');
    if (!(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');

    const action = catalogEntry(dto.actionId, dto.version);
    // Anything outside the catalog is refused by name, whoever suggested it.
    if (!action) throw new BadRequestException({ code: 'ACTION_NOT_IN_CATALOG', message: 'Only catalog actions can be requested. Arbitrary commands, scripts and anything not in the catalog are refused.' });
    if (!action.params.safeParse(dto.params).success) throw new BadRequestException({ code: 'PARAMS_NOT_ALLOWED', message: 'Those parameters are not allowed for this action.' });

    const target = {
      endpointId: ep.id, businessId: ep.customerId, businessName: ep.customer.name.slice(0, 120), hostname: (ep.hostname ?? ep.name).slice(0, 64),
      deviceClass: ep.deviceClass, rustdeskId: ep.rustdeskNode?.rustdeskId ?? '', deviceSecretSha256: ep.rustdeskNode?.agentSecretHash ?? '',
    };
    const risk = action.risk([target]);
    const decision = await this.policy.evaluateAction(actor, ep, risk);
    if (!decision.ok) {
      await this.audit.log({ tenantId: ep.tenantId ?? undefined, customerId: ep.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_DISPATCH_BLOCKED', resource: 'endpoint', resourceId: ep.id, meta: { stage: 'request', action: action.id, reason: decision.reason } });
      throw new ForbiddenException({ code: decision.reason.toUpperCase(), message: decision.message });
    }
    const notReady = this.readiness(ep, `${action.id}@${action.version}`);
    if (notReady) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: notReady });
    // One at a time, and never a retry over an outcome nobody has looked at:
    // an UNKNOWN job blocks until a person reconciles it, even once the agent
    // has answered "uncertain".
    const pending = await this.prisma.actionJob.findFirst({
      where: { endpointId: ep.id, actionId: action.id, OR: [{ status: { in: UNRESOLVED }, result: { equals: Prisma.DbNull }, reconciledAt: null }, { status: 'UNKNOWN', reconciledAt: null }] },
      select: { id: true, status: true },
    });
    if (pending?.status === 'UNKNOWN') throw new ConflictException({ code: 'ACTION_UNRECONCILED', message: 'An earlier run of this action on this computer has an uncertain outcome. Check the computer and record what you found (Reconcile) before requesting it again.', jobId: pending.id });
    if (pending) throw new ConflictException({ code: 'ACTION_PENDING', message: `An earlier request for this action on this computer is still ${pending.status.toLowerCase().replace(/_/g, ' ')}. Resolve it first.`, jobId: pending.id });

    const signerPolicy = await this.signer.policy(ep.customerId);
    if (signerPolicy.status !== 200) throw new ConflictException({ code: 'APPROVAL_SIGNER_ERROR', message: 'The approval signer did not return this business\'s policy.' });
    const now = new Date();
    const notBefore = new Date(now.getTime() + dto.startsInMinutes * 60_000);
    const notAfter = new Date(notBefore.getTime() + dto.windowHours * 3600_000);
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true, email: true } });
    const plan: Plan = {
      schema: PLAN_SCHEMA,
      jobId: randomBytes(16).toString('hex'),
      action: { id: action.id, version: action.version },
      artifact: { target: 'windows/rem0te-agent.exe', sha256: this.updateTrust.agentTarget()!.sha256 },
      params: dto.params,
      targets: [target],
      requestedBy: { userId: actor.userId, name: ([user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || actor.userId).slice(0, 120), via: origin.via },
      origin: { kind: origin.kind, ticketRef: origin.ticketRef },
      reason: dto.reason,
      policy: { risk, approvalsRequired: APPROVALS_REQUIRED[risk], customerSignoff: !!signerPolicy.body.customerSignoff },
      window: { notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString() },
      createdAt: now.toISOString(),
      approvers: [],
      signedAt: null,
    };
    const check = Plan.safeParse(plan);
    if (!check.success) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: 'This computer\'s identity is incomplete; it cannot be named in a plan.' });
    const submitted = await this.signer.submit(plan);
    if (submitted.status !== 201 || !submitted.body.approvalUrl || submitted.body.digest !== planDigest(plan)) {
      throw new ConflictException({ code: 'APPROVAL_SIGNER_REFUSED', message: submitted.body.message ?? submitted.body.error ?? 'The approval signer refused the plan.' });
    }
    const job = await this.prisma.actionJob.create({
      data: {
        id: plan.jobId, tenantId: ep.tenantId, customerId: ep.customerId, endpointId: ep.id, actionId: action.id, actionVersion: action.version,
        params: dto.params as Prisma.InputJsonValue, reason: dto.reason, origin: origin.kind, via: origin.via, ticketRef: origin.ticketRef,
        requestedById: actor.userId, risk, approvalsRequired: plan.policy.approvalsRequired, customerSignoff: plan.policy.customerSignoff,
        notBefore, notAfter, plan: plan as unknown as Prisma.InputJsonValue, digest: submitted.body.digest!, approvalUrl: submitted.body.approvalUrl,
        integrationPeer: integration?.peer ?? null, integrationKey: integration?.key ?? null,
      },
    });
    await this.audit.log({
      tenantId: ep.tenantId ?? undefined, customerId: ep.customerId, actorId: actor.userId, actorIp: actor.ip,
      action: 'ACTION_REQUESTED', resource: 'action_job', resourceId: job.id,
      meta: { endpointId: ep.id, action: `${action.id}@${action.version}`, params: dto.params, risk, approvalsRequired: plan.policy.approvalsRequired, customerSignoff: plan.policy.customerSignoff, origin: origin.kind, via: origin.via, ticketRef: origin.ticketRef, digest: job.digest },
    });
    return this.view(job);
  }

  view(j: ActionJob) {
    const a = catalogEntry(j.actionId, j.actionVersion);
    return {
      id: j.id, status: j.status, statusReason: j.statusReason, endpointId: j.endpointId, businessId: j.customerId,
      action: { id: j.actionId, version: j.actionVersion, title: a?.title ?? j.actionId, warnings: a?.warnings ?? [] },
      params: j.params, reason: j.reason, origin: j.origin, via: j.via, ticketRef: j.ticketRef, requestedById: j.requestedById,
      risk: j.risk, approvalsRequired: j.approvalsRequired, customerSignoff: j.customerSignoff,
      window: { notBefore: j.notBefore, notAfter: j.notAfter }, digest: j.digest, approvalUrl: j.approvalUrl,
      approvers: j.approvers, dispatchedAt: j.dispatchedAt, deliveries: j.deliveries, outcome: j.outcome, result: j.result, resultAt: j.resultAt,
      reconciled: j.reconciledAt ? { at: j.reconciledAt, byId: j.reconciledById, note: j.reconcileNote } : null,
      createdAt: j.createdAt, updatedAt: j.updatedAt,
    };
  }

  /** Pull the signer's state into the job. Idempotent; safe to call on every read. */
  async refresh(j: ActionJob): Promise<ActionJob> {
    if (j.status !== 'AWAITING_APPROVAL' || !this.signer.configured()) return j;
    let s: Awaited<ReturnType<SignerClient['status']>>;
    try { s = await this.signer.status(j.id); } catch { return j; }
    if (s.status !== 200 || !s.body.status) return j;
    const next: Partial<ActionJob> = {};
    if (s.body.status === 'SIGNED' && s.body.envelope) {
      const env = Envelope.safeParse(s.body.envelope);
      let plan: Plan | null = null;
      if (env.success) { try { const p = Plan.safeParse(JSON.parse(Buffer.from(env.data.plan, 'base64').toString('utf8'))); plan = p.success ? p.data : null; } catch { plan = null; } }
      // The signer must have signed THIS plan. The agent verifies the
      // signature; this only stops a confused signer's envelope being stored.
      if (!plan || plan.jobId !== j.id || planDigest(plan) !== j.digest) {
        next.status = 'CANCELED'; next.statusReason = 'signer_returned_a_different_plan';
      } else {
        next.status = 'APPROVED'; next.envelope = env.data as unknown as Prisma.JsonValue; next.approvers = plan.approvers as unknown as Prisma.JsonValue;
      }
    } else if (s.body.status === 'REJECTED' || s.body.status === 'CANCELED' || s.body.status === 'EXPIRED') {
      next.status = s.body.status; next.statusReason = s.body.status === 'REJECTED' ? `rejected by ${s.body.decisions?.find((d) => d.decision === 'reject')?.name ?? 'an approver'}` : null;
    } else return j;
    const r = await this.prisma.actionJob.updateMany({ where: { id: j.id, status: 'AWAITING_APPROVAL' }, data: next as Prisma.ActionJobUpdateManyMutationInput });
    if (r.count) {
      await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_APPROVAL_UPDATED', resource: 'action_job', resourceId: j.id, meta: { status: next.status, statusReason: next.statusReason ?? null, approvers: (next.approvers as unknown[] | undefined)?.length ?? 0 } });
    }
    return (await this.prisma.actionJob.findUnique({ where: { id: j.id } }))!;
  }

  private async scoped(actor: ActorContext, id: string) {
    const j = await this.prisma.actionJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('Action not found');
    await this.acl.assertEndpointInScope(actor, j.endpointId).catch(() => { throw new NotFoundException('Action not found'); });
    return j;
  }

  async get(actor: ActorContext, id: string) { return this.view(await this.refresh(await this.scoped(actor, id))); }

  async list(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const rows = await this.prisma.actionJob.findMany({ where: { endpointId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const out = [];
    for (const r of rows) out.push(this.view(await this.refresh(r)));
    return out;
  }

  async cancel(actor: ActorContext, id: string) {
    const j = await this.scoped(actor, id);
    const mayCancel = actor.isPlatformAdmin || j.requestedById === actor.userId || (!actor.technician && actor.businessId === j.customerId && this.acl.isBusinessOwner(actor));
    if (!mayCancel) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only the requester, a Business Owner of this business or a Platform Admin can cancel.' });
    if (j.status === 'AWAITING_APPROVAL') await this.signer.cancel(j.id).catch(() => undefined);
    // Never after delivery: once the agent may have it, only its result decides.
    const r = await this.prisma.actionJob.updateMany({ where: { id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELED', statusReason: `canceled by ${actor.email ?? actor.userId}` } });
    if (!r.count) throw new ConflictException({ code: 'NOT_CANCELABLE', message: `This action is ${j.status.toLowerCase().replace(/_/g, ' ')}; it can no longer be canceled.` });
    await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_CANCELED', resource: 'action_job', resourceId: id });
    return this.view((await this.prisma.actionJob.findUnique({ where: { id } }))!);
  }

  /**
   * Record what a person found after an uncertain outcome. Only once the agent
   * can no longer run this job — it answered from its journal, or the signed
   * window has closed — so a reconciled job can never run alongside a retry.
   */
  async reconcile(actor: ActorContext, id: string, raw: unknown, now = new Date()) {
    const dto = ReconcileDto.safeParse(raw);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'found (running | stopped | other) and a note of at least 3 characters are required.' });
    const j = await this.scoped(actor, id);
    const may = actor.isPlatformAdmin || j.requestedById === actor.userId || (!actor.technician && actor.businessId === j.customerId && this.acl.isBusinessOwner(actor));
    if (!may) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only the requester, a Business Owner of this business or a Platform Admin can reconcile.' });
    if (j.status !== 'UNKNOWN' || j.reconciledAt) throw new ConflictException({ code: 'NOT_RECONCILABLE', message: `This action is ${j.status.toLowerCase().replace(/_/g, ' ')}${j.reconciledAt ? ' and already reconciled' : ''}; only an uncertain outcome is reconciled.` });
    if (j.result === null && now < j.notAfter) {
      throw new ConflictException({ code: 'AGENT_MAY_STILL_RUN', message: 'The computer has not answered yet and its approval window is still open, so it could still run this. Wait for its answer or for the window to close.' });
    }
    const r = await this.prisma.actionJob.updateMany({
      where: { id, status: 'UNKNOWN', reconciledAt: null },
      data: { reconciledAt: now, reconciledById: actor.userId, reconcileNote: `found ${dto.data.found}: ${dto.data.note}` },
    });
    if (!r.count) throw new ConflictException({ code: 'NOT_RECONCILABLE', message: 'Already reconciled.' });
    await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_RECONCILED', resource: 'action_job', resourceId: id, meta: { found: dto.data.found, note: dto.data.note, agentAnswered: j.result !== null } });
    return this.view((await this.prisma.actionJob.findUnique({ where: { id } }))!);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /**
   * Envelopes for this computer's authenticated heartbeat. The first delivery
   * of each job re-checks everything that could have changed since approval;
   * re-deliveries (for reconciliation) are the same envelope, which the agent
   * answers from its journal and never runs twice.
   */
  async forHeartbeat(endpointId: string, now = new Date()): Promise<{ jobId: string; envelope: unknown }[]> {
    const rows = await this.prisma.actionJob.findMany({
      where: { endpointId, status: { in: ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED', 'UNKNOWN'] }, result: { equals: Prisma.DbNull }, reconciledAt: null },
      orderBy: { createdAt: 'asc' }, take: 10,
    });
    const out: { jobId: string; envelope: unknown }[] = [];
    for (let j of rows) {
      if (out.length >= MAX_DELIVER) break;
      j = await this.refresh(j);
      if (j.status === 'APPROVED') {
        if (now < j.notBefore) continue; // not yet; nothing to say
        const blocked = now >= j.notAfter ? 'window_closed' : await this.dispatchBlock(j);
        if (blocked) {
          await this.prisma.actionJob.updateMany({ where: { id: j.id, status: 'APPROVED' }, data: { status: blocked === 'window_closed' ? 'EXPIRED' : 'CANCELED', statusReason: blocked } });
          await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, actorId: j.requestedById, action: 'ACTION_DISPATCH_BLOCKED', resource: 'action_job', resourceId: j.id, meta: { stage: 'dispatch', reason: blocked } });
          continue;
        }
        const r = await this.prisma.actionJob.updateMany({ where: { id: j.id, status: 'APPROVED' }, data: { status: 'DISPATCHED', dispatchedAt: now, deliveries: { increment: 1 }, lastDeliveredAt: now } });
        if (!r.count) continue;
        await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, actorId: j.requestedById, action: 'ACTION_DISPATCHED', resource: 'action_job', resourceId: j.id, meta: { endpointId } });
        out.push({ jobId: j.id, envelope: j.envelope });
      } else if (j.status === 'DISPATCHED' || j.status === 'UNKNOWN') {
        if (j.status === 'DISPATCHED' && j.dispatchedAt && now.getTime() - j.dispatchedAt.getTime() > RESULT_DEADLINE_MS) {
          await this.prisma.actionJob.updateMany({ where: { id: j.id, status: 'DISPATCHED' }, data: { status: 'UNKNOWN', statusReason: 'no result from the computer within 30 minutes; reconciling from its journal' } });
        }
        await this.prisma.actionJob.update({ where: { id: j.id }, data: { deliveries: { increment: 1 }, lastDeliveredAt: now } });
        out.push({ jobId: j.id, envelope: j.envelope });
      }
    }
    return out;
  }

  /** Everything that could have changed between approval and the first delivery. */
  private async dispatchBlock(j: ActionJob): Promise<string | null> {
    const ep = await this.endpointFor(j.endpointId);
    if (!ep || !ep.customerId || ep.customerId !== j.customerId || ep.status === 'ARCHIVED' || !ep.customer?.isActive || ep.customer.isArchived) return 'computer_no_longer_in_business';
    const plan = j.plan as unknown as Plan;
    const t = plan.targets[0];
    if (ep.rustdeskNode?.agentSecretHash !== t.deviceSecretSha256 || ep.rustdeskNode?.rustdeskId !== t.rustdeskId) return 'device_identity_changed';
    if (ep.deviceClass !== t.deviceClass) return 'device_class_changed';
    const live = await this.actors.contextFor(j.requestedById, ep.tenantId ?? '', j.customerId);
    if (!live || (live.businessId !== j.customerId && !live.isPlatformAdmin)) return 'requester_no_longer_authorized';
    if (!(await this.acl.canReachEndpoint(live, ep))) return 'requester_no_longer_authorized';
    const d = await this.policy.evaluateAction(live, ep, plan.policy.risk);
    if (!d.ok) return d.reason === 'identity_paused' ? 'requester_paused' : d.reason === 'protected_device_class' ? 'protected_device_class' : 'requester_no_longer_authorized';
    const admitted = await this.abuse.admit({ identity: `user:${j.requestedById}`, tier: d.tier, kind: 'WRITE', endpointId: ep.id, customerId: ep.customerId, entryPoint: j.via === 'clientst0r' ? 'integration' : 'ui' });
    if (!admitted.ok) return admitted.reason;
    return null;
  }

  /** Results the agent reported on an authenticated heartbeat. Returns the ids to acknowledge. */
  async recordResults(endpointId: string, raw: unknown): Promise<string[]> {
    if (!Array.isArray(raw)) return [];
    const acks: string[] = [];
    for (const item of raw.slice(0, 10)) {
      const p = AgentResult.safeParse(item);
      if (!p.success) continue;
      const r = p.data;
      const j = await this.prisma.actionJob.findUnique({ where: { id: r.jobId } });
      if (!j || j.endpointId !== endpointId) continue; // never another computer's job — and no ack, so it is not hidden either
      acks.push(r.jobId);
      if (j.result !== null || !['DISPATCHED', 'UNKNOWN'].includes(j.status)) continue;
      const status = STATUS_FOR[r.outcome];
      const u = await this.prisma.actionJob.updateMany({
        where: { id: j.id, status: { in: ['DISPATCHED', 'UNKNOWN'] }, result: { equals: Prisma.DbNull } },
        data: { status, outcome: r.outcome, statusReason: r.reason ?? null, result: r as unknown as Prisma.InputJsonValue, resultAt: new Date() },
      });
      if (u.count) {
        await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_RESULT', resource: 'action_job', resourceId: j.id, meta: { endpointId, outcome: r.outcome, reason: r.reason ?? null, observed: r.observed ?? null } });
      }
    }
    return acks;
  }
}
