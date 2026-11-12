import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ActionJob, type ActionJobStatus, type ActionTarget, type ActionTargetStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, technicianGrantAllows, type ActorContext } from '../rbac/access-control.service';
import type { Capability } from '../rbac/capabilities';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { AbuseGuardService } from '../security-controls/abuse-guard.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import {
  APPROVALS_REQUIRED, CATALOG, Envelope, LOG_SOURCES, MAX_WINDOW_HOURS, PLAN_SCHEMA, Plan, catalogEntry, planDigest, UPDATE_INSTALL, type CatalogAction,
} from './catalog';
import { sanitizeLogs } from './logs';
import { DeviceSigned, RESULT_STATUS } from './device-result';
import { SCRIPT_RUN_ACTION, scriptPlanProblem, type ScriptBlock } from './script-run';
import { ScriptAgentResult, sanitizeScriptOutput, scriptSummary } from './script-output';
import { SignerClient } from './signer.client';
import { ContainmentService } from '../containment/containment.service';

/**
 * Approved actions, portal side (v0.26; one plan, many computers since
 * v0.27). The portal proposes, re-checks and delivers; it cannot approve or
 * sign. What it delivers is an envelope the approval signer made, which each
 * agent verifies against a key it learned through the offline-rooted update
 * chain.
 *
 * A job is one signed plan. Each computer the plan names is an ActionTarget
 * with its own delivery, result and reconciliation; the job's status is
 * rolled up from them.
 *
 *   AWAITING_APPROVAL ─signer quorum─▶ APPROVED ─first delivery─▶ DISPATCHED ─every target answered─▶ SUCCEEDED | FAILED | REFUSED_BY_ENDPOINT | NOT_EXECUTED
 *        │                               │                           │
 *        └▶ REJECTED / CANCELED / EXPIRED └▶ EXPIRED (nobody reached)  └─ a target past its deadline ▶ UNKNOWN
 *
 * Per target: PENDING ─rechecked─▶ DISPATCHED ─agent─▶ SUCCEEDED | FAILED | REFUSED_BY_ENDPOINT | NOT_EXECUTED
 *                │                     └─ no result by the action's deadline ▶ UNKNOWN (still offered; the journal answers)
 *                └▶ CANCELED (recheck failed, window closed, plan canceled)
 *
 * An UNKNOWN target keeps being offered: the agent answers from its journal
 * and never runs a job twice. A new job for the same action on that computer
 * is refused until a person reconciles it.
 */

const LIVE_JOB: ActionJobStatus[] = ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED', 'UNKNOWN'];
const OPEN_TARGET: ActionTargetStatus[] = ['PENDING', 'DISPATCHED', 'UNKNOWN'];
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
  found: z.enum(['running', 'stopped', 'installed', 'not_installed', 'restart_scheduled', 'no_restart_scheduled', 'other']),
  note: z.string().trim().min(3).max(500),
  endpointId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
}).strict();

const PatchOutcome = z.object({
  updateId: z.string().regex(/^[0-9a-f-]{36}$/), revision: z.number().int(), kb: z.string().max(16).optional(),
  state: z.enum(['installed', 'restart_required', 'already_installed', 'superseded', 'not_offered', 'excluded', 'failed', 'not_attempted', 'unknown']),
  reason: z.string().max(200).optional(), hresult: z.string().max(12).optional(),
}).strict();

export const AgentResult = z.object({
  jobId: z.string().regex(/^[a-f0-9]{32}$/),
  outcome: z.enum(['succeeded', 'already_running', 'failed', 'refused', 'not_executed', 'uncertain', 'restart_required', 'partial', 'no_change', 'timed_out']),
  reason: z.string().max(200).optional(),
  detail: z.string().max(500).optional(),
  observed: z.record(z.string(), z.string().max(80)).optional(),
  executedAt: z.string().max(40).optional(),
  agentSha256: z.string().max(64).optional(),
  updates: z.array(PatchOutcome).max(20).optional(),
  reboot: z.object({ pending: z.boolean(), sources: z.array(z.string().max(32)).max(8) }).strict().optional(),
  // windows.update.install with reboot if_required_in_window (0.34): what the
  // agent did about a restart. Kept only for a plan that allowed one.
  restart: z.object({
    state: z.enum(['scheduled', 'restart_deferred', 'not_required']),
    reason: z.enum(['remote_session_open', 'session_state_unknown', 'window_closed', 'restart_already_scheduled', 'schedule_failed', 'install_uncertain', 'no_maintenance', 'no_restart_pending', 'nothing_installed']).optional(),
    scheduledFor: z.string().datetime().optional(),
    delayMinutes: z.number().int().min(1).max(1440).optional(),
  }).strict().optional(),
  // windows.logs.collect (0.32). Bounded here, then redacted again and capped
  // by sanitizeLogs before anything is stored.
  logs: z.array(z.object({
    source: z.enum(LOG_SOURCES), text: z.string().max(16_384), truncated: z.boolean(), note: z.string().max(300).optional(),
  }).strict()).max(LOG_SOURCES.length).optional(),
  // v0.34: the computer's signature over the result's gate facts. Stored as
  // received and relayed to the approval signer; the portal never builds one.
  signed: DeviceSigned.optional().catch(undefined),
  // windows.script.run (0.34). Base64, bounded here; decoded, redacted again
  // and capped by sanitizeScriptOutput, and stored apart from the result.
  script: ScriptAgentResult.optional(),
}).strict();
export type AgentResult = z.infer<typeof AgentResult>;

const STATUS_FOR: Record<AgentResult['outcome'], ActionTargetStatus> = RESULT_STATUS;

type Ep = NonNullable<Awaited<ReturnType<ActionsService['endpointFor']>>>;
type PlanTarget = Plan['targets'][number];
export type JobWithTargets = ActionJob & { targets: ActionTarget[] };

export interface PlanRequest {
  action: CatalogAction;
  endpointIds: string[];
  params: Record<string, unknown>;
  reason: string;
  startsInMinutes: number;
  windowHours: number;
  origin?: { kind: 'technician' | 'ai_suggestion'; ticketRef: string | null; via: 'portal' | 'clientst0r' };
  integration?: { peer: string; key: string };
  display?: Plan['display'];
  deployment?: { id: string; ring: number };
  /** 0.32: an exact window (a patch policy's maintenance window) instead of startsInMinutes/windowHours. */
  window?: { notBefore: Date; notAfter: Date };
  /**
   * 0.32: submit under a patch policy. The signer signs it at once if it is
   * inside that policy, and refuses it otherwise; nobody is asked to approve.
   */
  underPolicy?: { policyId: string; digest: string; evidence: unknown };
  /** 0.34, windows.script.run: the signer's allowlist entry for the version (script-run.ts ScriptBlock). */
  script?: ScriptBlock;
}

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
    private readonly containment: ContainmentService,
  ) {}

  catalog() {
    return {
      configured: this.signer.configured(),
      actions: CATALOG.map((a) => ({
        id: a.id, version: a.version, title: a.title, description: a.description, warnings: a.warnings, verification: a.verification, doesNotProve: a.doesNotProve,
        direct: a.direct, maxTargets: a.maxTargets, acknowledge: a.acknowledge, choice: a.choice ?? null, requiresCapability: a.requiresCapability ?? null,
        maxWindowHours: a.maxWindowHours ?? MAX_WINDOW_HOURS,
        // What one standard workstation needs; anything else is always high.
        workstationRisk: a.risk([{ deviceClass: 'WORKSTATION' }]),
      })),
    };
  }

  /**
   * Does this person hold the action's extra capability (0.32:
   * windows.logs.collect needs computers:event_logs) for every one of these
   * computers? For a technician it must come from the same grant as the
   * computer, as for the Event Log tab.
   */
  private mayRead(actor: ActorContext | undefined, a: CatalogAction | null, endpointIds: string[]): boolean {
    if (!a?.requiresCapability) return true;
    if (!actor) return false;
    if (actor.isPlatformAdmin) return true;
    const cap = a.requiresCapability as Capability;
    if (actor.technician) return endpointIds.length > 0 && endpointIds.every((id) => technicianGrantAllows(actor.technician!, cap, id));
    return this.acl.can(actor, cap);
  }

  async endpointFor(endpointId: string) {
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
  readiness(ep: Ep, key: string): string | null {
    if (!ep.rustdeskNode?.agentSecretHash || !ep.rustdeskNode.rustdeskId) return 'This computer has no enrolled device identity.';
    if (ep.updateChannel !== 'signed') return 'This computer runs a legacy agent. Migrate it to the signed agent first (docs/update-signing.md).';
    if (!ep.agentActions.includes(key)) return 'This computer\'s agent does not report support for this action. Update it first.';
    const served = this.updateTrust.agentTarget();
    if (!served) return 'No signed agent build is published, so no plan can name one.';
    if (ep.agentSha256 !== served.sha256) return 'This computer\'s agent is not the currently published signed build; it would refuse the plan. Let it update first.';
    return null;
  }

  private targetOf(ep: Ep): PlanTarget {
    return {
      endpointId: ep.id, businessId: ep.customerId!, businessName: ep.customer!.name.slice(0, 120), hostname: (ep.hostname ?? ep.name).slice(0, 64),
      deviceClass: ep.deviceClass, rustdeskId: ep.rustdeskNode?.rustdeskId ?? '', deviceSecretSha256: ep.rustdeskNode?.agentSecretHash ?? '',
    };
  }

  /** The job, if any, that blocks a new request for this action on this computer. */
  async blocking(endpointId: string, actionId: string) {
    return this.prisma.actionTarget.findFirst({
      where: {
        endpointId, job: { actionId },
        OR: [{ status: { in: OPEN_TARGET }, result: { equals: Prisma.DbNull }, reconciledAt: null, job: { status: { in: LIVE_JOB } } }, { status: 'UNKNOWN', reconciledAt: null }],
      },
      select: { jobId: true, status: true },
    });
  }

  /** One computer, from its Actions tab (or ClientSt0r): the 0.26 path. */
  async request(actor: ActorContext, endpointId: string, raw: unknown, origin: PlanRequest['origin'] = { kind: 'technician', ticketRef: null, via: 'portal' }, integration?: { peer: string; key: string }) {
    const parsed = RequestDto.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const dto = parsed.data;
    const action = catalogEntry(dto.actionId, dto.version);
    // Anything outside the catalog is refused by name, whoever suggested it.
    if (!action) {
      await this.acl.assertEndpointInScope(actor, endpointId);
      throw new BadRequestException({ code: 'ACTION_NOT_IN_CATALOG', message: 'Only catalog actions can be requested. Arbitrary commands, scripts and anything not in the catalog are refused.' });
    }
    if (!action.direct) {
      await this.acl.assertEndpointInScope(actor, endpointId);
      throw new BadRequestException({ code: 'ACTION_NOT_DIRECT', message: action.id === SCRIPT_RUN_ACTION
        ? 'Scripts are run from an approved version in the script library, which names the script and its allowlist entry.'
        : 'Windows updates are installed through a patch deployment, ring by ring, not one computer at a time.' });
    }
    const job = await this.createPlan(actor, {
      action, endpointIds: [endpointId], params: dto.params, reason: dto.reason, startsInMinutes: dto.startsInMinutes, windowHours: dto.windowHours, origin, integration,
    });
    return this.view(job, actor);
  }

  /**
   * Build, check and submit one plan naming one or more computers of one
   * business. Every computer is checked as if requested alone: scope, live
   * access, protected class, readiness and the one-at-a-time rule.
   */
  async createPlan(actor: ActorContext, r: PlanRequest): Promise<JobWithTargets> {
    const action = r.action;
    const origin = r.origin ?? { kind: 'technician' as const, ticketRef: null, via: 'portal' as const };
    if (r.endpointIds.length < 1 || r.endpointIds.length > action.maxTargets || new Set(r.endpointIds).size !== r.endpointIds.length) {
      throw new BadRequestException({ code: 'BAD_TARGETS', message: `This action names 1 to ${action.maxTargets} distinct computers per plan.` });
    }
    const eps: Ep[] = [];
    for (const id of r.endpointIds) {
      await this.acl.assertEndpointInScope(actor, id);
      const ep = await this.endpointFor(id);
      if (!ep || !ep.customerId || !ep.customer || ep.status === 'ARCHIVED' || !ep.customer.isActive || ep.customer.isArchived) throw new NotFoundException('Computer not found');
      if (!(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
      eps.push(ep);
    }
    if (new Set(eps.map((e) => e.customerId)).size !== 1) throw new BadRequestException({ code: 'BAD_TARGETS', message: 'A plan names computers of one business only.' });
    if (!action.params.safeParse(r.params).success) throw new BadRequestException({ code: 'PARAMS_NOT_ALLOWED', message: 'Those parameters are not allowed for this action.' });
    const maxWindow = action.maxWindowHours ?? MAX_WINDOW_HOURS;
    if (r.windowHours > maxWindow) throw new BadRequestException({ code: 'WINDOW_TOO_LONG', message: `This action's approval window is at most ${maxWindow} hour${maxWindow === 1 ? '' : 's'}.` });
    // 0.32: collecting logs reads event-log text, so it needs what reading
    // the Event Log tab needs, as well as permission to request actions.
    if (!this.mayRead(actor, action, eps.map((e) => e.id))) {
      await this.audit.log({ tenantId: eps[0].tenantId ?? undefined, customerId: eps[0].customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_DISPATCH_BLOCKED', resource: 'endpoint', resourceId: eps[0].id, meta: { stage: 'request', action: action.id, reason: 'capability_missing', capability: action.requiresCapability } });
      throw new ForbiddenException({ code: 'ACTION_NOT_GRANTED', message: `Requesting this action also needs ${action.requiresCapability}.` });
    }

    const targets = eps.map((ep) => this.targetOf(ep));
    const risk = action.risk(targets);
    for (const ep of eps) {
      const decision = await this.policy.evaluateAction(actor, ep, risk);
      if (!decision.ok) {
        await this.audit.log({ tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_DISPATCH_BLOCKED', resource: 'endpoint', resourceId: ep.id, meta: { stage: 'request', action: action.id, reason: decision.reason } });
        throw new ForbiddenException({ code: decision.reason.toUpperCase(), message: eps.length > 1 ? `${ep.hostname ?? ep.name}: ${decision.message}` : decision.message });
      }
      const notReady = this.readiness(ep, `${action.id}@${action.version}`);
      if (notReady) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: eps.length > 1 ? `${ep.hostname ?? ep.name}: ${notReady}` : notReady, endpointId: ep.id });
      // One at a time, and never a retry over an outcome nobody has looked at.
      const pending = await this.blocking(ep.id, action.id);
      if (pending?.status === 'UNKNOWN') throw new ConflictException({ code: 'ACTION_UNRECONCILED', message: 'An earlier run of this action on this computer has an uncertain outcome. Check the computer and record what you found (Reconcile) before requesting it again.', jobId: pending.jobId, endpointId: ep.id });
      if (pending) throw new ConflictException({ code: 'ACTION_PENDING', message: `An earlier request for this action on ${ep.hostname ?? ep.name} is still ${pending.status.toLowerCase().replace(/_/g, ' ')}. Resolve it first.`, jobId: pending.jobId, endpointId: ep.id });
    }
    const first = eps[0];
    // A ring is admitted against the fleet-abuse limit once, here: it is one
    // decision, approved as one plan. Single-computer plans are admitted at
    // dispatch, as in 0.26.
    if (eps.length > 1) {
      const tier = this.policy.tierFor(actor, first.id);
      const admitted = await this.abuse.admit({ identity: `user:${actor.userId}`, tier, kind: 'WRITE', endpointId: first.id, customerId: first.customerId!, entryPoint: origin.via === 'clientst0r' ? 'integration' : 'ui' });
      if (!admitted.ok) throw new ForbiddenException({ code: admitted.reason.toUpperCase(), message: admitted.message });
    }

    const signerPolicy = await this.signer.policy(first.customerId!);
    if (signerPolicy.status !== 200) throw new ConflictException({ code: 'APPROVAL_SIGNER_ERROR', message: 'The approval signer did not return this business\'s policy.' });
    const now = new Date();
    const notBefore = r.window?.notBefore ?? new Date(now.getTime() + r.startsInMinutes * 60_000);
    const notAfter = r.window?.notAfter ?? new Date(notBefore.getTime() + r.windowHours * 3600_000);
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true, email: true } });
    const plan: Plan = {
      schema: PLAN_SCHEMA,
      jobId: randomBytes(16).toString('hex'),
      action: { id: action.id, version: action.version },
      artifact: { target: 'windows/rem0te-agent.exe', sha256: this.updateTrust.agentTarget()!.sha256 },
      params: r.params,
      targets,
      requestedBy: { userId: actor.userId, name: ([user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || actor.userId).slice(0, 120), via: origin.via },
      origin: { kind: origin.kind, ticketRef: origin.ticketRef },
      reason: r.reason,
      policy: { risk, approvalsRequired: APPROVALS_REQUIRED[risk], customerSignoff: !!signerPolicy.body.customerSignoff },
      window: { notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString() },
      ...(r.display ? { display: r.display } : {}),
      ...(r.script ? { script: r.script } : {}),
      createdAt: now.toISOString(),
      approvers: [],
      signedAt: null,
    };
    const check = Plan.safeParse(plan);
    if (!check.success) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: 'A computer\'s identity is incomplete; it cannot be named in a plan.' });
    // 0.34: the script rules the signer and the agent apply, applied here first (§ 39).
    const scriptProblem = scriptPlanProblem(check.data);
    if (scriptProblem) throw new BadRequestException({ code: 'PARAMS_NOT_ALLOWED', message: `This plan does not describe its script consistently (${scriptProblem}).` });
    const submitted = r.underPolicy
      ? await this.signer.submitUnderPolicy(r.underPolicy.policyId, { plan, policyDigest: r.underPolicy.digest, evidence: r.underPolicy.evidence })
      : await this.signer.submit(plan);
    if (submitted.status !== 201 || !submitted.body.approvalUrl || submitted.body.digest !== planDigest(plan)) {
      // Under a policy, the signer's own code says which bound the plan crossed.
      throw new ConflictException({ code: r.underPolicy ? 'POLICY_REFUSED' : 'APPROVAL_SIGNER_REFUSED', signerCode: submitted.body.error ?? null, message: submitted.body.message ?? submitted.body.error ?? 'The approval signer refused the plan.' });
    }
    const job = await this.prisma.actionJob.create({
      data: {
        id: plan.jobId, tenantId: first.tenantId, customerId: first.customerId!, endpointId: first.id, actionId: action.id, actionVersion: action.version,
        params: r.params as Prisma.InputJsonValue, reason: r.reason, origin: origin.kind, via: origin.via, ticketRef: origin.ticketRef,
        requestedById: actor.userId, risk, approvalsRequired: plan.policy.approvalsRequired, customerSignoff: plan.policy.customerSignoff,
        notBefore, notAfter, plan: plan as unknown as Prisma.InputJsonValue, digest: submitted.body.digest!, approvalUrl: submitted.body.approvalUrl,
        integrationPeer: r.integration?.peer ?? null, integrationKey: r.integration?.key ?? null,
        deploymentId: r.deployment?.id ?? null, ring: r.deployment?.ring ?? null,
        targets: { create: eps.map((ep) => ({ endpointId: ep.id })) },
      },
      include: { targets: true },
    });
    await this.audit.log({
      tenantId: first.tenantId ?? undefined, customerId: first.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
      action: 'ACTION_REQUESTED', resource: 'action_job', resourceId: job.id,
      meta: { endpointIds: eps.map((e) => e.id), action: `${action.id}@${action.version}`, params: r.params, risk, approvalsRequired: plan.policy.approvalsRequired, customerSignoff: plan.policy.customerSignoff, origin: origin.kind, via: origin.via, ticketRef: origin.ticketRef, digest: job.digest, deployment: r.deployment ?? null, underPolicy: r.underPolicy?.policyId ?? null },
    });
    // Signed already, by the signer's own decision: pull the envelope now.
    if (r.underPolicy) { await this.refresh(job); return (await this.prisma.actionJob.findUnique({ where: { id: job.id }, include: { targets: true } }))!; }
    return job;
  }

  /**
   * The job as the portal shows it. viewer decides whether collected content
   * (windows.logs.collect's text) is included: without a viewer who holds the
   * action's capability it is replaced by a note, never sent.
   */
  async view(j: ActionJob & { targets?: ActionTarget[] }, viewer?: ActorContext) {
    const a = catalogEntry(j.actionId, j.actionVersion);
    const targets = j.targets ?? await this.prisma.actionTarget.findMany({ where: { jobId: j.id } });
    const readable = this.mayRead(viewer, a, targets.map((t) => t.endpointId));
    const shown = (r: Prisma.JsonValue | null) => {
      if (readable || !r || typeof r !== 'object' || Array.isArray(r) || !('logs' in r)) return r;
      const { logs: _logs, ...rest } = r as Record<string, unknown>;
      return { ...rest, logsWithheld: `Collected text needs ${a?.requiresCapability ?? 'a capability you do not hold'}.` } as Prisma.JsonValue;
    };
    const names = new Map((await this.prisma.endpoint.findMany({ where: { id: { in: targets.map((t) => t.endpointId) } }, select: { id: true, name: true, hostname: true } })).map((e) => [e.id, e.hostname ?? e.name]));
    // 0.34: a script run's output lives apart from its result (90-day retention); shown to whoever may see the job.
    const outputs = j.actionId === SCRIPT_RUN_ACTION
      ? new Map((await this.prisma.scriptRunOutput.findMany({ where: { targetId: { in: targets.map((t) => t.id) } } })).map((o) => [o.targetId, o]))
      : new Map<string, never>();
    const script = j.actionId === SCRIPT_RUN_ACTION ? (j.plan as unknown as Plan).script ?? null : null;
    return {
      id: j.id, status: j.status, statusReason: j.statusReason, endpointId: j.endpointId, businessId: j.customerId,
      action: { id: j.actionId, version: j.actionVersion, title: a?.title ?? j.actionId, warnings: a?.warnings ?? [] },
      params: j.params, reason: j.reason, origin: j.origin, via: j.via, ticketRef: j.ticketRef, requestedById: j.requestedById,
      risk: j.risk, approvalsRequired: j.approvalsRequired, customerSignoff: j.customerSignoff,
      window: { notBefore: j.notBefore, notAfter: j.notAfter }, digest: j.digest, approvalUrl: j.approvalUrl,
      approvers: j.approvers, dispatchedAt: j.dispatchedAt, deliveries: j.deliveries, outcome: j.outcome, result: shown(j.result), resultAt: j.resultAt,
      reconciled: j.reconciledAt ? { at: j.reconciledAt, byId: j.reconciledById, note: j.reconcileNote } : null,
      deploymentId: j.deploymentId, ring: j.ring,
      script: script ? { name: script.name, version: script.version, scriptId: script.scriptId, versionId: script.versionId, contentSha256: script.contentSha256 } : undefined,
      targets: targets.map((t) => ({
        endpointId: t.endpointId, hostname: names.get(t.endpointId) ?? null, status: t.status, statusReason: t.statusReason,
        deliveries: t.deliveries, dispatchedAt: t.dispatchedAt, outcome: t.outcome, result: shown(t.result), resultAt: t.resultAt,
        reconciled: t.reconciledAt ? { at: t.reconciledAt, byId: t.reconciledById, note: t.reconcileNote } : null,
        ...(script ? { scriptOutput: scriptOutputView(outputs.get(t.id), t.resultAt) } : {}),
      })),
      createdAt: j.createdAt, updatedAt: j.updatedAt,
    };
  }

  /** Pull the signer's state into the job. Idempotent; safe to call on every read. */
  async refresh<T extends ActionJob>(j: T): Promise<ActionJob> {
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
      if (next.status !== 'APPROVED') await this.prisma.actionTarget.updateMany({ where: { jobId: j.id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: next.statusReason ?? next.status!.toLowerCase() } });
      await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_APPROVAL_UPDATED', resource: 'action_job', resourceId: j.id, meta: { status: next.status, statusReason: next.statusReason ?? null, approvers: (next.approvers as unknown[] | undefined)?.length ?? 0 } });
    }
    return (await this.prisma.actionJob.findUnique({ where: { id: j.id } }))!;
  }

  /**
   * Recompute the job from its targets. Targets nobody reached before the
   * window closed are canceled (the agent would refuse them as expired).
   */
  async rollup(jobId: string, now = new Date()): Promise<JobWithTargets> {
    let j = (await this.prisma.actionJob.findUnique({ where: { id: jobId }, include: { targets: true } }))!;
    if ((j.status === 'APPROVED' || j.status === 'DISPATCHED' || j.status === 'UNKNOWN') && now >= j.notAfter) {
      const swept = await this.prisma.actionTarget.updateMany({ where: { jobId, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: 'window_closed' } });
      if (swept.count) j = (await this.prisma.actionJob.findUnique({ where: { id: jobId }, include: { targets: true } }))!;
    }
    const ts = j.targets;
    const next: Prisma.ActionJobUpdateManyMutationInput = {};
    if (j.status === 'APPROVED' && ts.every((t) => t.status === 'CANCELED')) {
      next.status = ts.every((t) => t.statusReason === 'window_closed') ? 'EXPIRED' : 'CANCELED';
      next.statusReason = ts.length === 1 ? ts[0].statusReason : 'no computer could be delivered to';
    } else if (j.status === 'DISPATCHED' || j.status === 'UNKNOWN') {
      const open = ts.filter((t) => (t.status === 'PENDING' || t.status === 'DISPATCHED'));
      const unknown = ts.filter((t) => t.status === 'UNKNOWN' && !t.reconciledAt);
      const answered = ts.filter((t) => t.result !== null);
      if (unknown.length) next.status = 'UNKNOWN';
      else if (open.length) next.status = 'DISPATCHED';
      else {
        const has = (s: ActionTargetStatus) => ts.some((t) => t.status === s);
        next.status = has('FAILED') ? 'FAILED' : has('REFUSED_BY_ENDPOINT') ? 'REFUSED_BY_ENDPOINT' : has('SUCCEEDED') ? 'SUCCEEDED' : has('UNKNOWN') ? 'UNKNOWN' : 'NOT_EXECUTED';
      }
      if (ts.length === 1) {
        const t = ts[0];
        Object.assign(next, { outcome: t.outcome, result: (t.result ?? Prisma.DbNull) as Prisma.InputJsonValue, resultAt: t.resultAt, reconciledAt: t.reconciledAt, reconciledById: t.reconciledById, reconcileNote: t.reconcileNote });
        if (t.statusReason && t.statusReason !== j.statusReason && t.status !== 'DISPATCHED') next.statusReason = t.statusReason;
      } else {
        const counts = new Map<string, number>();
        for (const t of ts) counts.set(t.outcome ?? t.status.toLowerCase(), (counts.get(t.outcome ?? t.status.toLowerCase()) ?? 0) + 1);
        next.outcome = [...counts].map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ').slice(0, 200);
        if (answered.length === ts.length) next.resultAt = answered.map((t) => t.resultAt!).sort((a, b) => b.getTime() - a.getTime())[0];
        if (unknown.length === 0 && ts.some((t) => t.status === 'UNKNOWN')) {
          const rec = ts.filter((t) => t.reconciledAt).sort((a, b) => b.reconciledAt!.getTime() - a.reconciledAt!.getTime())[0];
          Object.assign(next, { reconciledAt: rec?.reconciledAt ?? null, reconciledById: rec?.reconciledById ?? null, reconcileNote: rec ? `${ts.filter((t) => t.reconciledAt).length} computer(s) reconciled` : null });
        }
      }
    }
    if (Object.keys(next).length) {
      await this.prisma.actionJob.updateMany({ where: { id: jobId, status: j.status }, data: next });
      j = (await this.prisma.actionJob.findUnique({ where: { id: jobId }, include: { targets: true } }))!;
    }
    return j;
  }

  private async scoped(actor: ActorContext, id: string) {
    const j = await this.prisma.actionJob.findUnique({ where: { id }, include: { targets: true } });
    if (!j) throw new NotFoundException('Action not found');
    // Seeing the job needs every computer it names to be in scope: a ring
    // plan is not readable through access to one of its computers.
    for (const t of j.targets) await this.acl.assertEndpointInScope(actor, t.endpointId).catch(() => { throw new NotFoundException('Action not found'); });
    return j;
  }

  async load(id: string): Promise<JobWithTargets> {
    const j = (await this.prisma.actionJob.findUnique({ where: { id } }))!;
    await this.refresh(j);
    return this.rollup(id);
  }

  async get(actor: ActorContext, id: string) { await this.scoped(actor, id); return this.view(await this.load(id), actor); }

  async list(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const rows = await this.prisma.actionJob.findMany({ where: { targets: { some: { endpointId } } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true } });
    const out = [];
    for (const r of rows) {
      const j = await this.load(r.id);
      const v = await this.view(j, actor);
      // A ring plan, seen from one computer: that computer's row only.
      out.push(v.targets.length > 1 ? { ...v, targets: v.targets.filter((t) => t.endpointId === endpointId), ringSize: v.targets.length } : v);
    }
    return out;
  }

  private mayManage(actor: ActorContext, j: ActionJob) {
    return actor.isPlatformAdmin || j.requestedById === actor.userId || (!actor.technician && actor.businessId === j.customerId && this.acl.isBusinessOwner(actor));
  }

  async cancel(actor: ActorContext, id: string) {
    const j = await this.scoped(actor, id);
    if (!this.mayManage(actor, j)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only the requester, a Business Owner of this business or a Platform Admin can cancel.' });
    if (j.status === 'AWAITING_APPROVAL') await this.signer.cancel(j.id).catch(() => undefined);
    // Never after delivery: once an agent may have it, only its result decides.
    const r = await this.prisma.actionJob.updateMany({ where: { id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELED', statusReason: `canceled by ${actor.email ?? actor.userId}` } });
    if (!r.count) throw new ConflictException({ code: 'NOT_CANCELABLE', message: `This action is ${j.status.toLowerCase().replace(/_/g, ' ')}; it can no longer be canceled.` });
    await this.prisma.actionTarget.updateMany({ where: { jobId: id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: 'plan canceled' } });
    await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_CANCELED', resource: 'action_job', resourceId: id });
    return this.view(await this.load(id), actor);
  }

  /**
   * Record what a person found on one computer after an uncertain outcome.
   * Only once that computer can no longer run this job — it answered from
   * its journal, or the signed window has closed — so a reconciled job can
   * never run alongside a retry.
   */
  async reconcile(actor: ActorContext, id: string, raw: unknown, now = new Date()) {
    const dto = ReconcileDto.safeParse(raw);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'found (running | stopped | installed | not_installed | restart_scheduled | no_restart_scheduled | other) and a note of at least 3 characters are required.' });
    const j = await this.scoped(actor, id);
    if (!this.mayManage(actor, j)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only the requester, a Business Owner of this business or a Platform Admin can reconcile.' });
    const t = dto.data.endpointId ? j.targets.find((x) => x.endpointId === dto.data.endpointId) : j.targets.length === 1 ? j.targets[0] : undefined;
    if (!t) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Name the computer to reconcile (endpointId): this plan names several.' });
    if (t.status !== 'UNKNOWN' || t.reconciledAt) throw new ConflictException({ code: 'NOT_RECONCILABLE', message: `This computer's result is ${t.status.toLowerCase().replace(/_/g, ' ')}${t.reconciledAt ? ' and already reconciled' : ''}; only an uncertain outcome is reconciled.` });
    if (t.result === null && now < j.notAfter) {
      throw new ConflictException({ code: 'AGENT_MAY_STILL_RUN', message: 'The computer has not answered yet and its approval window is still open, so it could still run this. Wait for its answer or for the window to close.' });
    }
    const r = await this.prisma.actionTarget.updateMany({
      where: { id: t.id, status: 'UNKNOWN', reconciledAt: null },
      data: { reconciledAt: now, reconciledById: actor.userId, reconcileNote: `found ${dto.data.found}: ${dto.data.note}` },
    });
    if (!r.count) throw new ConflictException({ code: 'NOT_RECONCILABLE', message: 'Already reconciled.' });
    await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'ACTION_RECONCILED', resource: 'action_job', resourceId: id, meta: { endpointId: t.endpointId, found: dto.data.found, note: dto.data.note, agentAnswered: t.result !== null } });
    return this.view(await this.rollup(id, now), actor);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /**
   * Envelopes for this computer's authenticated heartbeat. The first delivery
   * to each computer re-checks everything that could have changed since
   * approval; re-deliveries (for reconciliation, or while a long action runs)
   * are the same envelope, which the agent answers from its journal or its
   * lock and never runs twice.
   */
  async forHeartbeat(endpointId: string, now = new Date()): Promise<{ jobId: string; envelope: unknown; script?: { content: string } }[]> {
    const rows = await this.prisma.actionTarget.findMany({
      where: { endpointId, status: { in: OPEN_TARGET }, result: { equals: Prisma.DbNull }, reconciledAt: null, job: { status: { in: LIVE_JOB } } },
      orderBy: { createdAt: 'asc' }, take: 10,
    });
    const out: { jobId: string; envelope: unknown; script?: { content: string } }[] = [];
    for (const t of rows) {
      if (out.length >= MAX_DELIVER) break;
      const job = await this.refresh((await this.prisma.actionJob.findUnique({ where: { id: t.jobId } }))!);
      if (job.status === 'AWAITING_APPROVAL') continue;
      if (!['APPROVED', 'DISPATCHED', 'UNKNOWN'].includes(job.status)) { await this.rollup(job.id, now); continue; }
      const action = catalogEntry(job.actionId, job.actionVersion);
      // v0.28: while actions are paused for this business (or everywhere),
      // nothing is handed over — not a first delivery, not a re-delivery. A
      // pending plan waits, and expires unrun if its window closes first. The
      // deadline below still runs, so a plan already delivered can still be
      // marked uncertain.
      const held = !!(await this.containment.blocking('actions', job.customerId));
      if (t.status === 'PENDING') {
        if (held) continue;
        if (now < job.notBefore) continue; // not yet; nothing to say
        const blocked = now >= job.notAfter ? 'window_closed' : await this.dispatchBlock(job, endpointId);
        if (blocked) {
          await this.prisma.actionTarget.updateMany({ where: { id: t.id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: blocked } });
          await this.audit.log({ tenantId: job.tenantId ?? undefined, customerId: job.customerId, actorId: job.requestedById, action: 'ACTION_DISPATCH_BLOCKED', resource: 'action_job', resourceId: job.id, meta: { stage: 'dispatch', endpointId, reason: blocked } });
          await this.rollup(job.id, now);
          continue;
        }
        const r = await this.prisma.actionTarget.updateMany({ where: { id: t.id, status: 'PENDING' }, data: { status: 'DISPATCHED', dispatchedAt: now, deliveries: { increment: 1 }, lastDeliveredAt: now } });
        if (!r.count) continue;
        await this.prisma.actionJob.updateMany({ where: { id: job.id, status: 'APPROVED' }, data: { status: 'DISPATCHED', dispatchedAt: now } });
        await this.prisma.actionJob.update({ where: { id: job.id }, data: { deliveries: { increment: 1 }, lastDeliveredAt: now } });
        await this.audit.log({ tenantId: job.tenantId ?? undefined, customerId: job.customerId, actorId: job.requestedById, action: 'ACTION_DISPATCHED', resource: 'action_job', resourceId: job.id, meta: { endpointId } });
        out.push({ jobId: job.id, envelope: job.envelope, ...(await this.scriptFor(job)) });
      } else {
        const deadline = (action?.resultDeadlineMinutes ?? 30) * 60_000;
        if (t.status === 'DISPATCHED' && t.dispatchedAt && now.getTime() - t.dispatchedAt.getTime() > deadline) {
          await this.prisma.actionTarget.updateMany({ where: { id: t.id, status: 'DISPATCHED' }, data: { status: 'UNKNOWN', statusReason: `no result from the computer within ${Math.round(deadline / 60_000)} minutes; reconciling from its journal` } });
          await this.rollup(job.id, now);
        }
        if (held) continue;
        await this.prisma.actionTarget.update({ where: { id: t.id }, data: { deliveries: { increment: 1 }, lastDeliveredAt: now } });
        await this.prisma.actionJob.update({ where: { id: job.id }, data: { deliveries: { increment: 1 }, lastDeliveredAt: now } });
        out.push({ jobId: job.id, envelope: job.envelope, ...(await this.scriptFor(job)) });
      }
    }
    return out;
  }

  /**
   * 0.34: the script content handed to the agent beside a script run's
   * envelope. The portal is only a courier here: the agent hashes these bytes
   * and refuses them unless they are exactly the signed SHA-256. The version
   * row is immutable (migration 0035's trigger), so this is what was approved.
   */
  private async scriptFor(job: ActionJob): Promise<{ script?: { content: string } }> {
    if (job.actionId !== SCRIPT_RUN_ACTION) return {};
    const id = (job.params as { scriptVersionId?: unknown } | null)?.scriptVersionId;
    const v = typeof id === 'string' ? await this.prisma.scriptVersion.findUnique({ where: { id }, select: { content: true } }) : null;
    return v ? { script: { content: Buffer.from(v.content, 'utf8').toString('base64') } } : {};
  }

  /** Everything that could have changed for this computer between approval and its first delivery. */
  private async dispatchBlock(j: ActionJob, endpointId: string): Promise<string | null> {
    const ep = await this.endpointFor(endpointId);
    if (!ep || !ep.customerId || ep.customerId !== j.customerId || ep.status === 'ARCHIVED' || !ep.customer?.isActive || ep.customer.isArchived) return 'computer_no_longer_in_business';
    const plan = j.plan as unknown as Plan;
    const t = plan.targets.find((x) => x.endpointId === endpointId);
    if (!t) return 'computer_not_in_plan';
    if (ep.rustdeskNode?.agentSecretHash !== t.deviceSecretSha256 || ep.rustdeskNode?.rustdeskId !== t.rustdeskId) return 'device_identity_changed';
    if (ep.deviceClass !== t.deviceClass) return 'device_class_changed';
    const live = await this.actors.contextFor(j.requestedById, ep.tenantId ?? '', j.customerId);
    if (!live || (live.businessId !== j.customerId && !live.isPlatformAdmin)) return 'requester_no_longer_authorized';
    if (!(await this.acl.canReachEndpoint(live, ep))) return 'requester_no_longer_authorized';
    const d = await this.policy.evaluateAction(live, ep, plan.policy.risk);
    if (!d.ok) return d.reason === 'identity_paused' ? 'requester_paused' : d.reason === 'protected_device_class' ? 'protected_device_class' : d.reason === 'contained' ? 'contained' : 'requester_no_longer_authorized';
    if (!this.mayRead(live, catalogEntry(j.actionId, j.actionVersion), [ep.id])) return 'requester_lost_capability';
    if (plan.targets.length === 1) {
      const admitted = await this.abuse.admit({ identity: `user:${j.requestedById}`, tier: d.tier, kind: 'WRITE', endpointId: ep.id, customerId: ep.customerId, entryPoint: j.via === 'clientst0r' ? 'integration' : 'ui' });
      if (!admitted.ok) return admitted.reason;
    }
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
      // Never another computer's result — and no ack, so it is not hidden either.
      const t = await this.prisma.actionTarget.findUnique({ where: { jobId_endpointId: { jobId: r.jobId, endpointId } }, include: { job: { select: { actionId: true, plan: true, notAfter: true } } } });
      if (!t) continue;
      acks.push(r.jobId);
      if (t.result !== null || !['DISPATCHED', 'UNKNOWN'].includes(t.status)) continue;
      // Collected text only for the action that collects it, redacted again
      // here (the agent's redaction is not trusted) and capped.
      if (r.logs) r.logs = t.job.actionId === 'windows.logs.collect' ? sanitizeLogs(r.logs) : undefined;
      // A restart report only from an update plan whose signed rule allowed one.
      const planReboot = (t.job.plan as unknown as Plan | null)?.params?.reboot;
      if (r.restart && !(t.job.actionId === UPDATE_INSTALL.id && planReboot === 'if_required_in_window')) r.restart = undefined;
      // 0.34: a script's output only for a script run, redacted again here,
      // and stored apart (ScriptRunOutput, 90 days); the result keeps a summary.
      const script = r.script && t.job.actionId === SCRIPT_RUN_ACTION ? r.script : null;
      const stored = { ...r, script: script ? scriptSummary(script) : undefined };
      const u = await this.prisma.actionTarget.updateMany({
        where: { id: t.id, status: { in: ['DISPATCHED', 'UNKNOWN'] }, result: { equals: Prisma.DbNull } },
        data: { status: STATUS_FOR[r.outcome], outcome: r.outcome, statusReason: r.reason ?? null, result: stored as unknown as Prisma.InputJsonValue, resultAt: new Date() },
      });
      if (u.count && r.restart?.state === 'scheduled' && r.restart.scheduledFor) {
        // The canary's proof is a scan after the restart: ask for one once the
        // restart is due (patchScanDue waits until then), never later than
        // the plan's window allows the restart to have been.
        const at = new Date(Date.parse(r.restart.scheduledFor) + 2 * 60_000);
        if (at.getTime() > Date.now() - 3_600_000 && at.getTime() <= t.job.notAfter.getTime() + 2 * 60_000) {
          await this.prisma.endpoint.update({ where: { id: endpointId }, data: { patchScanRequestedAt: at } });
        }
      }
      if (u.count && script) {
        const o = sanitizeScriptOutput(script);
        const job = await this.prisma.actionJob.findUnique({ where: { id: r.jobId }, select: { customerId: true, params: true } });
        await this.prisma.scriptRunOutput.create({ data: {
          targetId: t.id, jobId: r.jobId, endpointId, customerId: job!.customerId, scriptVersionId: String((job!.params as { scriptVersionId?: unknown }).scriptVersionId ?? ''), contentSha256: script.contentSha256,
          exitCode: o.exitCode, timedOut: o.timedOut, durationMs: o.durationMs, stdout: o.stdout.text, stderr: o.stderr.text,
          stdoutBytes: o.stdoutBytes, stderrBytes: o.stderrBytes, stdoutTruncated: o.stdout.truncated, stderrTruncated: o.stderr.truncated,
        } }).catch((e) => this.log.warn(`script output for ${r.jobId}/${endpointId} not stored: ${(e as Error).message}`));
      }
      if (u.count) {
        const j = await this.rollup(r.jobId);
        await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_RESULT', resource: 'action_job', resourceId: j.id, meta: { endpointId, outcome: r.outcome, reason: r.reason ?? null, observed: r.observed ?? null, restart: r.restart ?? null, updates: r.updates?.map((x) => `${x.kb ?? x.updateId}:${x.state}`) ?? null, logs: r.logs?.map((x) => `${x.source}:${x.text.length}${x.truncated ? '+' : ''}`) ?? null, script: script ? { exitCode: script.exitCode, timedOut: script.timedOut, contentSha256: script.contentSha256, stdoutBytes: script.stdoutBytes, stderrBytes: script.stderrBytes } : null } });
      }
    }
    return acks;
  }
}

/** A run's stored output as the portal shows it; pruned after 90 days. */
function scriptOutputView(o: { exitCode: number | null; timedOut: boolean; durationMs: number | null; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; createdAt: Date } | undefined, resultAt: Date | null) {
  if (!o) return resultAt ? { pruned: true } : null;
  return { exitCode: o.exitCode, timedOut: o.timedOut, durationMs: o.durationMs, stdout: o.stdout, stderr: o.stderr, stdoutBytes: o.stdoutBytes, stderrBytes: o.stderrBytes, stdoutTruncated: o.stdoutTruncated, stderrTruncated: o.stderrTruncated, recordedAt: o.createdAt };
}
