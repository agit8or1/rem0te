import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type AutomationPolicy } from '@prisma/client';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { assertFresh } from '../security-controls/review';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { DIRECT, SCRIPT_RUN, SOFTWARE_INSTALL, SOFTWARE_UNINSTALL, type CatalogAction } from '../actions/catalog';
import { ContainmentService } from '../containment/containment.service';
import { GroupMembershipService } from '../group-policy/membership.service';
import { ScriptRunService } from '../script-run/script-run.service';
import { SoftwareService } from '../software/software.service';
import { connectivityOf } from '../common/connectivity';
import {
  AUTOMATION_SCHEMA, AutomationDoc, AutomationOffline, AutomationRecurrence, HOURLY_EVERY, MAX_AUTOMATION_DAYS, MAX_AUTOMATION_TARGETS, MAX_RUNS_PER_OCCURRENCE,
  automationDigest, automationNextOccurrence, automationNextOccurrences, automationOccurrenceAt, latestNotAfter, offlineInWords, recurrenceInWords, recurrenceKind,
  taskAction, taskInWords, targetsInWords, validateAutomationDoc, type AutomationTask, type RestartTask,
} from '../actions/automation-policy';
import { REBOOT_SCHEDULE } from '../actions/catalog';
import type { PolicyWindow } from '../actions/patch-policy';

/**
 * Automation schedules (0.58, docs/automation.md).
 *
 * An automation policy is a recurring windows.script.run@1 of one approved
 * library version, or windows.software.install@1 / uninstall@1 of one catalog
 * entry, on named computers or one device group, on an hourly, daily, weekly
 * or monthly schedule. Its document (actions/automation-policy.ts) is
 * approved on the approval signer, by two people with passkeys, or activated
 * there at admission in direct mode (§58). After that the signer signs each
 * occurrence's plan by itself — but only a plan inside the document, only
 * after its ordinary admission (the script still ACTIVE on its allowlist,
 * the package not revoked), never while a plan of the same policy is still
 * open, and at most `maxRunsPerOccurrence` per occurrence.
 *
 * This service proposes documents, mirrors their status, pauses, resumes and
 * revokes them, and runs AUTOMATION_SWEEP, which asks for each occurrence's
 * plan through ActionsService.createPlan — the same path, with the same
 * scope, access level, containment, readiness and one-at-a-time checks, as
 * any other request, on the author's behalf. It has no approve route and
 * signs nothing. Everything is off until someone makes a policy; nothing is
 * created by default.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const PolicyIdRe = /^[a-f0-9]{32}$/;

const TaskDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('script'), scriptVersionId: Id, parameters: z.record(z.string(), z.unknown()).default({}), timeoutMinutes: z.number().int() }).strict(),
  z.object({ kind: z.literal('software'), entryId: Id, operation: z.enum(['install', 'uninstall']) }).strict(),
]);
const TargetsDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('computers'), endpointIds: z.array(Id).min(1).max(MAX_AUTOMATION_TARGETS) }).strict(),
  z.object({ kind: z.literal('group'), groupId: Id, maxTargets: z.number().int().min(1).max(MAX_AUTOMATION_TARGETS) }).strict(),
]);
export const CreateAutomationDto = z.object({
  businessId: Id,
  name: z.string().trim().min(3).max(120),
  task: TaskDto,
  targets: TargetsDto,
  recurrence: AutomationRecurrence,
  offline: AutomationOffline,
  maxRunsPerOccurrence: z.number().int().min(1).max(MAX_RUNS_PER_OCCURRENCE).default(1),
  expiresInDays: z.number().int().min(1).max(MAX_AUTOMATION_DAYS).default(30),
  reason: z.string().trim().min(3).max(500),
  /** A revision: the policy this one replaces once it is ACTIVE. Widening is always a revision, approved again. */
  supersedes: z.string().regex(PolicyIdRe).optional(),
}).strict();
export type CreateAutomation = z.infer<typeof CreateAutomationDto>;
const ReasonDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const PreviewDto = z.object({ recurrence: z.unknown(), expiresInDays: z.number().int().min(1).max(MAX_AUTOMATION_DAYS).optional() }).strict();

/** Less than this left in an occurrence and nothing is proposed in it. */
const MIN_LEFT_MS = 5 * 60_000;
/** After a refusal in an occurrence, the sweep waits this long before asking again in it. */
const RETRY_AFTER_MS = 10 * 60_000;
/** A plan is open (no new one may start) while it is one of these and inside its window. */
const OPEN_JOB = ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED', 'UNKNOWN'] as const;
/** Codes from createPlan that name one computer; that computer is left out and the rest asked again. */
const PER_COMPUTER = new Set(['ENDPOINT_NOT_READY', 'ACTION_PENDING', 'ACTION_UNRECONCILED']);

type LastProposal = { at: string; occurrence: string | null; ok: boolean; code: string; message: string; jobId?: string | null };
type Skipped = { endpointId: string; computer: string; why: string };

@Injectable()
export class AutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Automation');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly access: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
    private readonly containment: ContainmentService,
    private readonly membership: GroupMembershipService,
    private readonly scripts: ScriptRunService,
    private readonly software: SoftwareService,
  ) {}

  // ── The sweep ─────────────────────────────────────────────────────────────

  static sweepEnabled() { return process.env.AUTOMATION_SWEEP !== 'off'; }
  static sweepSeconds() { return Math.max(2, Number(process.env.AUTOMATION_SWEEP_SECONDS) || 60); }

  onModuleInit() {
    if (!AutomationService.sweepEnabled()) return;
    const every = AutomationService.sweepSeconds() * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** One pass: mirror the signer, then ask for each open occurrence's plan. Never twice at once in this process; (policy, occurrence, attempt) is unique across processes. */
  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      // 0.60: restart windows are mirrored and run by RESTART_WINDOW_SWEEP (restart-windows/), not here.
      const rows = await this.prisma.automationPolicy.findMany({
        where: { taskKind: { not: 'restart' }, OR: [{ status: { in: ['AWAITING_APPROVAL', 'ACTIVE'] } }, { status: 'REVOKED', signerRevokedAt: null }] },
        orderBy: { createdAt: 'asc' }, take: 200,
      });
      for (const r0 of rows) {
        try {
          const r = await this.refresh(r0, now);
          if (r.status !== 'ACTIVE' || r.pausedAt) continue;
          await this.propose(r, now);
        } catch (e) { this.logger.warn(`automation ${r0.id}: ${(e as Error).message}`); }
      }
    } finally { this.busy = false; }
  }

  /** 0.60: the same mirror, for RestartWindowsService's own sweep and pages. */
  mirror(r: AutomationPolicy, now = new Date()): Promise<AutomationPolicy> { return this.refresh(r, now); }

  /** Mirror the signer's view of a policy; keep asking it to revoke until it confirms. */
  private async refresh(r: AutomationPolicy, now = new Date()): Promise<AutomationPolicy> {
    if (!this.signer.configured()) return r;
    if (r.status === 'REVOKED') {
      if (r.signerRevokedAt) return r;
      const out = await this.signer.revokeAutomation(r.id, r.revokeReason ?? 'revoked at the portal').catch(() => null);
      if (out?.status !== 200) return r;
      const u = await this.prisma.automationPolicy.update({ where: { id: r.id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } });
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'AUTOMATION_POLICY_UPDATED', resource: 'automation_policy', resourceId: r.id, meta: { signerConfirmedRevocation: true } });
      return u;
    }
    if (!['AWAITING_APPROVAL', 'ACTIVE'].includes(r.status)) return r;
    const s = await this.signer.automationStatus(r.id).catch(() => null);
    if (!s || s.status !== 200) {
      if (r.expiresAt <= now) return this.setStatus(r, 'EXPIRED', { reason: 'expired' });
      return r;
    }
    if (s.body.digest !== r.digest) {
      this.logger.error(`automation ${r.id}: the signer holds a different document (digest mismatch); not mirroring its status`);
      return r;
    }
    const st = s.body.status as AutomationPolicy['status'] | undefined;
    const approvals = (s.body.approvals ?? []) as unknown as Prisma.InputJsonValue;
    if (st === 'REVOKED') {
      // Revoked on the signer (its operator's CLI): the portal follows.
      const u = await this.prisma.automationPolicy.update({ where: { id: r.id }, data: { status: 'REVOKED', revokedAt: new Date(s.body.revokedAt ?? now), revokeReason: r.revokeReason ?? 'revoked on the approval signer', signerRevokedAt: new Date(s.body.revokedAt ?? now), approvals } });
      await this.stopPlans(u, 'the automation policy was revoked on the approval signer');
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'AUTOMATION_POLICY_REVOKED', resource: 'automation_policy', resourceId: r.id, meta: { by: 'approval signer' } });
      return u;
    }
    if (st && st !== r.status && ['AWAITING_APPROVAL', 'ACTIVE', 'REJECTED', 'EXPIRED'].includes(st)) return this.setStatus(r, st, { approvals: s.body.approvals ?? [] }, approvals);
    if (JSON.stringify(r.approvals ?? []) !== JSON.stringify(s.body.approvals ?? [])) return this.prisma.automationPolicy.update({ where: { id: r.id }, data: { approvals } });
    return r;
  }

  private async setStatus(r: AutomationPolicy, status: AutomationPolicy['status'], meta: Record<string, unknown>, approvals?: Prisma.InputJsonValue) {
    const u = await this.prisma.automationPolicy.update({ where: { id: r.id }, data: { status, ...(approvals !== undefined ? { approvals } : {}) } });
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'AUTOMATION_POLICY_UPDATED', resource: 'automation_policy', resourceId: r.id, meta: { from: r.status, status, ...meta } });
    // A revision replaces its predecessor only once it is itself approved.
    if (status === 'ACTIVE' && u.supersedesId) await this.supersede(u);
    return u;
  }

  /** The revision is ACTIVE: withdraw the policy it replaces (revoked here and on the signer). Only ever narrows. */
  private async supersede(u: AutomationPolicy, now = new Date()) {
    const old = await this.prisma.automationPolicy.findUnique({ where: { id: u.supersedesId! } });
    if (!old || old.customerId !== u.customerId || old.status === 'REVOKED') return;
    const reason = `replaced by the revision "${u.name}" (${u.id})`;
    const w = await this.prisma.automationPolicy.update({ where: { id: old.id }, data: { status: 'REVOKED', revokedAt: now, revokeReason: reason.slice(0, 300), supersededAt: now } });
    const stopped = await this.stopPlans(w, reason);
    const out = this.signer.configured() ? await this.signer.revokeAutomation(old.id, reason.slice(0, 300)).catch(() => null) : null;
    if (out?.status === 200) await this.prisma.automationPolicy.update({ where: { id: old.id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } });
    await this.audit.log({ tenantId: old.tenantId ?? undefined, customerId: old.customerId, action: 'AUTOMATION_POLICY_SUPERSEDED', resource: 'automation_policy', resourceId: old.id, meta: { supersededBy: u.id, signerConfirmed: out?.status === 200, canceledPlans: stopped } });
  }

  private async record(r: AutomationPolicy, p: Omit<LastProposal, 'at'>, audit: boolean, now: Date) {
    const last = r.lastProposal as LastProposal | null;
    if (last && last.occurrence === p.occurrence && last.code === p.code && last.ok === p.ok && (last.jobId ?? null) === (p.jobId ?? null)) return;
    const next = { at: now.toISOString(), ...p };
    await this.prisma.automationPolicy.update({ where: { id: r.id }, data: { lastProposal: next as unknown as Prisma.InputJsonValue } });
    r.lastProposal = next as unknown as Prisma.JsonValue;
    if (audit) {
      await this.audit.log({
        tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: r.createdById,
        action: p.ok ? 'AUTOMATION_RUN_PROPOSED' : 'AUTOMATION_RUN_REFUSED', resource: 'automation_policy', resourceId: r.id,
        meta: { occurrence: p.occurrence, code: p.code, message: p.message, jobId: p.jobId ?? null },
      });
    }
  }

  /** The occurrence's note when no plan was made in it (attempt 0): one row per occurrence, kept current. */
  private async note(r: AutomationPolicy, key: string, code: string, message: string, skipped: Skipped[] = []) {
    await this.prisma.automationOccurrence.upsert({
      where: { policyId_occurrenceKey_attempt: { policyId: r.id, occurrenceKey: key, attempt: 0 } },
      create: { policyId: r.id, customerId: r.customerId, occurrenceKey: key, attempt: 0, ok: false, code, message: message.slice(0, 500), skipped: skipped as unknown as Prisma.InputJsonValue },
      update: { code, message: message.slice(0, 500), skipped: skipped as unknown as Prisma.InputJsonValue },
    });
  }

  /** Inside an open occurrence: ask for its plan, unless one is still open or the occurrence has had its plans. */
  async propose(r: AutomationPolicy, now: Date) {
    const doc = AutomationDoc.parse(r.document);
    // 0.60: a restart window is proposed one computer at a time by RestartWindowsService, never here.
    if (doc.task.kind === 'restart' || doc.targets.kind === 'business' || doc.targets.kind === 'group_members') return;
    const occ = automationOccurrenceAt(now, doc.recurrence);
    if (!occ || now >= new Date(doc.expiresAt)) return;
    const key = occ.start.toISOString();
    const notAfter = latestNotAfter(doc, occ, now);
    if (!notAfter || notAfter.getTime() - now.getTime() < MIN_LEFT_MS) return;
    const rec = (ok: boolean, code: string, message: string, jobId: string | null = null, audit = true) => this.record(r, { occurrence: key, ok, code, message, jobId }, audit, now);

    const rows = await this.prisma.automationOccurrence.findMany({ where: { policyId: r.id, occurrenceKey: key }, orderBy: { attempt: 'asc' } });
    const plans = rows.filter((x) => x.attempt > 0 && x.jobId);
    if (plans.length >= doc.maxRunsPerOccurrence) return;
    const noteRow = rows.find((x) => x.attempt === 0);
    // A refusal in this occurrence: ask again only after a pause, so a standing refusal is not asked every minute.
    const last = r.lastProposal as LastProposal | null;
    if (last && last.occurrence === key && !last.ok && now.getTime() - Date.parse(last.at) < RETRY_AFTER_MS && noteRow) return;

    // No overlap: nothing new while a plan of this policy is still open (the signer refuses it too).
    const open = await this.prisma.actionJob.findFirst({
      where: { id: { in: (await this.prisma.automationOccurrence.findMany({ where: { policyId: r.id, jobId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 20, select: { jobId: true } })).map((x) => x.jobId!) }, status: { in: [...OPEN_JOB] }, notAfter: { gt: now } },
      select: { id: true, notAfter: true },
    });
    if (open) return rec(false, 'previous_run_open', `An earlier plan of this schedule (${open.id}) is still open until ${open.notAfter.toISOString()}. Runs never overlap.`, null, false);

    if (await this.containment.blocking('actions', r.customerId)) { await this.note(r, key, 'contained', 'Containment pauses actions for this business; nothing is proposed until it is lifted.'); return rec(false, 'contained', 'Containment pauses actions for this business; nothing is proposed until it is lifted.'); }
    const actor = await this.actors.contextFor(doc.createdBy.userId, r.tenantId ?? '', r.customerId);
    if (!actor) { const m = `${doc.createdBy.name}, who created this schedule, is no longer active or no longer reaches this business. Runs are requested on the author's behalf, so nothing runs. Revoke it and make a new one.`; await this.note(r, key, 'author_inactive', m); return rec(false, 'author_inactive', m); }
    // The task must still be runnable. The signer decides this regardless; asking first keeps the history honest.
    const taskProblem = doc.task.kind === 'script'
      ? await this.scripts.automationScriptProblem(doc.task.script.allowlistId)
      : await this.software.automationEntryProblem(doc.task.display.entryId, doc.task.display.entryRevision);
    if (taskProblem) { await this.note(r, key, 'task_revoked', `Nothing runs: ${taskProblem}.`); return rec(false, 'task_revoked', `Nothing runs: ${taskProblem}.`); }

    // Who: the named computers, or the group's members now; never anyone already named in this occurrence.
    const named = new Set((await this.prisma.actionTarget.findMany({ where: { jobId: { in: plans.map((p) => p.jobId!) } }, select: { endpointId: true } })).map((t) => t.endpointId));
    let candidates: string[];
    let cap: number;
    if (doc.targets.kind === 'computers') { candidates = doc.targets.computers.map((c) => c.endpointId); cap = doc.targets.computers.length; }
    else {
      try { await this.membership.groupForPolicy(r.customerId, doc.targets.groupId); } catch (e) {
        const m = `The device group "${doc.targets.groupName}" cannot be used: ${(e as Error).message}`;
        await this.note(r, key, 'group_unusable', m); return rec(false, 'group_unusable', m);
      }
      candidates = (await this.membership.snapshot([doc.targets.groupId])).members(doc.targets.groupId);
      cap = doc.targets.maxTargets;
    }
    const action = this.actionOf(doc.task);
    const skipped: Skipped[] = [];
    const eligible: string[] = [];
    for (const id of candidates) {
      if (named.has(id)) continue;
      const why = await this.notReady(actor, doc, action, id, now);
      const ep = await this.prisma.endpoint.findUnique({ where: { id }, select: { name: true, hostname: true } });
      const computer = (ep?.hostname ?? ep?.name ?? id).slice(0, 64);
      if (why) { skipped.push({ endpointId: id, computer, why }); continue; }
      if (eligible.length >= cap) { skipped.push({ endpointId: id, computer, why: `over this schedule's limit of ${cap} computer(s) per run` }); continue; }
      eligible.push(id);
    }
    if (!eligible.length) {
      const m = candidates.length && candidates.every((c) => named.has(c))
        ? 'Every computer was already named in a plan of this occurrence.'
        : `No computer can run it now${skipped.length ? `: ${skipped.slice(0, 3).map((s) => `${s.computer} — ${s.why}`).join('; ')}${skipped.length > 3 ? '…' : ''}` : ' (the group is empty).'}`;
      if (!(candidates.length && candidates.every((c) => named.has(c)))) await this.note(r, key, 'no_targets', m, skipped);
      return rec(false, 'no_targets', m, null, !plans.length);
    }

    // Ask. A refusal that names one computer leaves it out and asks again for the rest.
    let ids = eligible;
    for (let i = 0; i <= MAX_AUTOMATION_TARGETS && ids.length; i++) {
      try {
        const job = await this.actions.createPlan(actor, {
          action, endpointIds: ids, params: doc.task.params as unknown as Record<string, unknown>,
          reason: `${doc.name} — scheduled run of ${key}`.slice(0, 500), startsInMinutes: 0, windowHours: 24,
          window: { notBefore: now, notAfter },
          underPolicy: { policyId: r.id, digest: r.digest, evidence: null, kind: 'automation' },
          ...(doc.task.kind === 'script' ? { script: doc.task.script } : {}),
          display: { updates: [], deployment: null, policy: { id: r.id, name: doc.name.slice(0, 120), digest: r.digest }, ...(doc.task.kind === 'software' ? { software: doc.task.display } : {}) },
        });
        await this.prisma.automationOccurrence.create({
          data: { policyId: r.id, customerId: r.customerId, occurrenceKey: key, attempt: plans.length + 1, jobId: job.id, ok: true, code: 'proposed', message: `Signed for ${ids.length} computer(s), valid until ${notAfter.toISOString()}.`, targets: ids.length, skipped: skipped as unknown as Prisma.InputJsonValue },
        });
        return rec(true, 'proposed', `Signed for ${ids.length} computer(s)${skipped.length ? `; ${skipped.length} left out` : ''}.`, job.id);
      } catch (e) {
        const body = e instanceof HttpException ? (e.getResponse() as { code?: string; signerCode?: string | null; message?: string; endpointId?: string }) : null;
        if (body?.endpointId && body.code && PER_COMPUTER.has(body.code) && ids.includes(body.endpointId)) {
          const ep = await this.prisma.endpoint.findUnique({ where: { id: body.endpointId }, select: { name: true, hostname: true } });
          skipped.push({ endpointId: body.endpointId, computer: (ep?.hostname ?? ep?.name ?? body.endpointId).slice(0, 64), why: (body.message ?? body.code).slice(0, 200) });
          ids = ids.filter((x) => x !== body.endpointId);
          continue;
        }
        const code = (body?.signerCode ?? body?.code ?? 'error').toString().slice(0, 64);
        const m = (body?.message ?? (e as Error).message ?? 'The plan was refused.').slice(0, 400);
        await this.note(r, key, code, m, skipped);
        return rec(false, code, m);
      }
    }
    await this.note(r, key, 'no_targets', 'Every computer was left out.', skipped);
    return rec(false, 'no_targets', 'Every computer was left out.');
  }

  private actionOf(t: AutomationTask): CatalogAction {
    if (t.kind === 'restart') return REBOOT_SCHEDULE;
    if (t.kind === 'script') return SCRIPT_RUN;
    return taskAction(t).id === SOFTWARE_UNINSTALL.id ? SOFTWARE_UNINSTALL : SOFTWARE_INSTALL;
  }

  /** Why this computer cannot be in this occurrence's plan, or null. The same checks createPlan makes, asked first so one computer cannot stop the rest. */
  private async notReady(actor: ActorContext, doc: AutomationDoc, action: CatalogAction, endpointId: string, now: Date): Promise<string | null> {
    const ep = await this.actions.endpointFor(endpointId);
    if (!ep || ep.status === 'ARCHIVED' || ep.customerId !== doc.businessId) return 'it is no longer enrolled in this business';
    if (doc.targets.kind === 'computers') {
      const c = doc.targets.computers.find((x) => x.endpointId === endpointId);
      if (!c || ep.rustdeskNode?.rustdeskId !== c.rustdeskId || ep.rustdeskNode?.agentSecretHash !== c.deviceSecretSha256) return 'it was re-enrolled since the schedule was approved, so it is not the computer that was approved';
    }
    try { await this.acl.assertEndpointInScope(actor, endpointId); } catch { return 'the author no longer reaches it'; }
    if (!(await this.acl.canReachEndpoint(actor, ep))) return 'the author no longer reaches it';
    const d = await this.access.evaluateAction(actor, ep, 'high');
    if (!d.ok) return d.message;
    const nr = this.actions.readiness(ep, `${action.id}@${action.version}`);
    if (nr) return nr;
    const b = await this.actions.blocking(ep.id, action.id);
    if (b) return `an earlier run on it is ${b.status.toLowerCase().replace(/_/g, ' ')}`;
    if (doc.offline.mode === 'skip_if_offline') {
      const c = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { isOnline: true, lastSeenAt: true } });
      if (connectivityOf(!!c?.isOnline, c?.lastSeenAt ?? null, now.getTime()) !== 'online') return 'it was not online when the window opened (this schedule skips offline computers)';
    }
    return null;
  }

  /** Cancel what has not reached a computer. Anything delivered runs to its own result. */
  private async stopPlans(r: AutomationPolicy, why: string): Promise<number> {
    const ids = (await this.prisma.automationOccurrence.findMany({ where: { policyId: r.id, jobId: { not: null } }, select: { jobId: true } })).map((x) => x.jobId!);
    let n = 0;
    for (const j of await this.prisma.actionJob.findMany({ where: { id: { in: ids }, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, select: { id: true, status: true, tenantId: true, customerId: true } })) {
      if (j.status === 'AWAITING_APPROVAL') await this.signer.cancel(j.id).catch(() => undefined);
      const c = await this.prisma.actionJob.updateMany({ where: { id: j.id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELED', statusReason: why.slice(0, 200) } });
      if (!c.count) continue;
      n++;
      await this.prisma.actionTarget.updateMany({ where: { jobId: j.id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: 'plan canceled' } });
      await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_CANCELED', resource: 'action_job', resourceId: j.id, meta: { reason: why, automationPolicyId: r.id } });
    }
    return n;
  }

  // ── People ────────────────────────────────────────────────────────────────

  private bad(code: string, message: string): never { throw new BadRequestException({ code, message }); }

  /** Whether automation can be set up here at all, from real state only. */
  async readiness() {
    const configured = this.signer.configured();
    const caps = configured ? await this.signer.capabilities().catch(() => null) : null;
    const supports = caps?.status === 200 && (caps.body as { automations?: number }).automations === 1;
    const restarts = caps?.status === 200 && (caps.body as { restartWindows?: number }).restartWindows === 1;
    return {
      signerConfigured: configured, signerSupportsAutomation: supports, signerSupportsRestartWindows: restarts,
      sweep: { enabled: AutomationService.sweepEnabled(), everySeconds: AutomationService.sweepSeconds() },
      why: !configured ? 'Automation schedules need the approval signer (APPROVAL_SIGNER_INTERNAL_URL).' : !supports ? 'The approval signer answering is older than 0.58 and does not support automation policies. Install the 0.58 signer.' : null,
    };
  }

  /**
   * Propose an automation policy. Every computer is checked as the author,
   * now; the task as the author sees it; the document by the same rules the
   * signer applies. In direct mode the signer activates it at once, so it
   * needs a fresh sign-in under actions.direct as well.
   */
  async create(actor: ActorContext, raw: unknown, freshMethod: string | null, now = new Date()) {
    const parsed = CreateAutomationDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data!;
    const ready = await this.readiness();
    if (!ready.signerConfigured) throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_NOT_CONFIGURED', message: ready.why });
    if (!ready.signerSupportsAutomation) throw new ConflictException({ code: 'SIGNER_TOO_OLD', message: ready.why });
    await this.acl.assertBusinessInScope(actor, dto.businessId);
    const biz = await this.prisma.customer.findUnique({ where: { id: dto.businessId }, select: { name: true, tenantId: true, isActive: true, isArchived: true } });
    if (!biz || !biz.isActive || biz.isArchived) throw new NotFoundException('Business not found');

    let supersedes: AutomationPolicy | null = null;
    if (dto.supersedes) {
      supersedes = await this.scoped(actor, dto.supersedes);
      if (supersedes.customerId !== dto.businessId) this.bad('INVALID_REQUEST', 'A revision replaces a schedule of the same business.');
      if (!this.mayManage(actor, supersedes)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the schedule, a Business Owner of this business or a Platform Admin can revise it.' });
      if (['REVOKED', 'REJECTED', 'EXPIRED'].includes(supersedes.status)) this.bad('INVALID_REQUEST', 'That schedule is no longer live; make a new one instead of a revision.');
    }

    // The task, as the author sees it now.
    let task: AutomationDoc['task'];
    if (dto.task.kind === 'script') {
      const t = await this.scripts.automationTask(actor, dto.task.scriptVersionId, dto.task.parameters, dto.task.timeoutMinutes, dto.businessId);
      task = { kind: 'script', params: t.params, script: t.block };
    } else {
      const t = await this.software.automationTask(actor, dto.task.entryId, dto.task.operation, dto.businessId);
      task = { kind: 'software', operation: dto.task.operation, params: t.params, display: t.display };
    }

    // The computers: named ones bound to their enrolled identity; a group checked now as the author would be at each run.
    let targets: AutomationDoc['targets'];
    const check = async (id: string) => {
      await this.acl.assertEndpointInScope(actor, id);
      const ep = await this.actions.endpointFor(id);
      if (!ep || ep.customerId !== dto.businessId || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
      const name = (ep.hostname ?? ep.name).slice(0, 64);
      const dec = await this.access.evaluateAction(actor, ep, 'high');
      if (!dec.ok) throw new ForbiddenException({ code: dec.reason.toUpperCase(), message: `${name}: ${dec.message}`, endpointId: id });
      if (!ep.rustdeskNode?.rustdeskId || !ep.rustdeskNode.agentSecretHash) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: this computer has no enrolled device identity.`, endpointId: id });
      if (ep.updateChannel !== 'signed') throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: runs the standard agent. Move it to the signed agent first.`, endpointId: id });
      return { endpointId: id, hostname: name, rustdeskId: ep.rustdeskNode.rustdeskId, deviceSecretSha256: ep.rustdeskNode.agentSecretHash };
    };
    if (dto.targets.kind === 'computers') {
      if (new Set(dto.targets.endpointIds).size !== dto.targets.endpointIds.length) this.bad('BAD_TARGETS', 'A computer is named twice.');
      const computers = [];
      for (const id of dto.targets.endpointIds) computers.push(await check(id));
      targets = { kind: 'computers', computers };
    } else {
      const g = await this.membership.groupForPolicy(dto.businessId, dto.targets.groupId);
      // The author must be able to act on every computer the group holds now; later members are checked at each run.
      for (const id of (await this.membership.snapshot([g.id])).members(g.id)) {
        await this.acl.assertEndpointInScope(actor, id).catch(() => { throw new ForbiddenException({ code: 'GROUP_NOT_REACHABLE', message: `"${g.name}" holds a computer you cannot act on, so you cannot schedule it.` }); });
        const ep = await this.actions.endpointFor(id);
        const dec = ep ? await this.access.evaluateAction(actor, ep, 'high') : null;
        if (!dec?.ok) throw new ForbiddenException({ code: 'GROUP_NOT_REACHABLE', message: `"${g.name}" holds ${ep?.hostname ?? ep?.name ?? 'a computer'}, which you cannot act on: ${dec && !dec.ok ? dec.message : 'not found'}` });
      }
      targets = { kind: 'group', groupId: g.id, groupName: g.name.slice(0, 120), maxTargets: dto.targets.maxTargets };
    }

    const signerPolicy = await this.signer.policy(dto.businessId);
    if (signerPolicy.status !== 200) throw new ConflictException({ code: 'APPROVAL_SIGNER_ERROR', message: 'The approval signer did not return this business\'s policy.' });
    const direct = signerPolicy.body.approval === DIRECT;
    // §58: in direct mode the signer activates it at admission, with no approvers; the request is the decision.
    if (direct) assertFresh(freshMethod, { action: 'actions.direct', message: 'Direct mode: this schedule starts running as soon as you create it, with no approval step. Confirm it is you.' });

    const row = await this.submit(actor, { ...dto, businessName: biz.name, tenantId: biz.tenantId }, task, targets, supersedes, now);
    return this.detail(actor, row.id, now);
  }

  /**
   * 0.60: propose a restart window's policy (task `restart`). Called only by
   * RestartWindowsService, which has already checked who may set the window
   * and asked for a fresh sign-in (restart.window). The document goes to the
   * signer through the same submit() as any schedule; in direct mode it is
   * active at once, so it needs actions.direct as well.
   */
  async createRestart(actor: ActorContext, input: {
    businessId: string; name: string; task: RestartTask; targets: AutomationDoc['targets']; recurrence: PolicyWindow;
    maxRunsPerOccurrence: number; expiresInDays: number; reason: string; supersedes?: string | null;
  }, freshMethod: string | null, now = new Date()): Promise<AutomationPolicy> {
    const ready = await this.readiness();
    if (!ready.signerConfigured) throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_NOT_CONFIGURED', message: 'Restart windows need the approval signer (APPROVAL_SIGNER_INTERNAL_URL): every restart is a signed plan.' });
    if (!ready.signerSupportsRestartWindows) throw new ConflictException({ code: 'SIGNER_TOO_OLD', message: 'The approval signer answering is older than 0.60 and does not support restart windows. Install the 0.60 signer.' });
    await this.acl.assertBusinessInScope(actor, input.businessId);
    const biz = await this.prisma.customer.findUnique({ where: { id: input.businessId }, select: { name: true, tenantId: true, isActive: true, isArchived: true } });
    if (!biz || !biz.isActive || biz.isArchived) throw new NotFoundException('Business not found');
    let supersedes: AutomationPolicy | null = null;
    if (input.supersedes) {
      supersedes = await this.prisma.automationPolicy.findUnique({ where: { id: input.supersedes } });
      if (!supersedes || supersedes.customerId !== input.businessId || supersedes.taskKind !== 'restart' || ['REVOKED', 'REJECTED', 'EXPIRED'].includes(supersedes.status)) supersedes = null;
    }
    const signerPolicy = await this.signer.policy(input.businessId);
    if (signerPolicy.status !== 200) throw new ConflictException({ code: 'APPROVAL_SIGNER_ERROR', message: 'The approval signer did not return this business\'s policy.' });
    const direct = signerPolicy.body.approval === DIRECT;
    // §58: in direct mode the signer activates it at admission, with no approvers; the request is the decision.
    if (direct) assertFresh(freshMethod, { action: 'actions.direct', message: 'Direct mode: this restart window starts working as soon as you save it, with no approval step. Confirm it is you.' });
    return this.submit(actor, {
      businessId: input.businessId, businessName: biz.name, tenantId: biz.tenantId, name: input.name, recurrence: input.recurrence,
      offline: { mode: 'run_when_online' }, maxRunsPerOccurrence: input.maxRunsPerOccurrence, expiresInDays: input.expiresInDays, reason: input.reason,
    }, input.task, input.targets, supersedes, now);
  }

  /** The document, its checks, the signer, and the one row: shared by create() and createRestart(). */
  private async submit(actor: ActorContext, dto: {
    businessId: string; businessName: string; tenantId: string | null; name: string; recurrence: AutomationDoc['recurrence']; offline: AutomationDoc['offline'];
    maxRunsPerOccurrence: number; expiresInDays: number; reason: string;
  }, task: AutomationDoc['task'], targets: AutomationDoc['targets'], supersedes: AutomationPolicy | null, now: Date): Promise<AutomationPolicy> {
    const biz = { name: dto.businessName, tenantId: dto.tenantId };
    const action = this.actionOf(task);
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true, email: true } });
    const expiresAt = new Date(now.getTime() + dto.expiresInDays * 86_400_000);
    const doc: AutomationDoc = {
      schema: AUTOMATION_SCHEMA, policyId: randomBytes(16).toString('hex'), name: dto.name, businessId: dto.businessId, businessName: biz.name.slice(0, 120),
      task, targets, recurrence: dto.recurrence, offline: dto.offline, maxRunsPerOccurrence: dto.maxRunsPerOccurrence,
      ...(supersedes ? { supersedes: supersedes.id } : {}),
      createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      createdBy: { userId: actor.userId, name: ([user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || actor.userId).slice(0, 120) },
      reason: dto.reason,
    };
    const shape = AutomationDoc.safeParse(doc);
    if (!shape.success) this.bad('INVALID_REQUEST', shape.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = validateAutomationDoc(doc, now);
    if (!v.ok) this.bad(v.reason.toUpperCase(), v.message);
    const digest = automationDigest(doc);
    const sub = await this.signer.submitAutomation(doc);
    if (sub.status !== 201 || sub.body.digest !== digest || !sub.body.approvalUrl) {
      throw new ConflictException({ code: 'APPROVAL_SIGNER_REFUSED', signerCode: sub.body.error ?? null, message: sub.body.message ?? sub.body.error ?? 'The approval signer refused the schedule.' });
    }
    const activeNow = sub.body.direct === true && sub.body.status === 'ACTIVE';
    const row = await this.prisma.automationPolicy.create({
      data: {
        id: doc.policyId, tenantId: biz.tenantId, customerId: dto.businessId, name: dto.name, taskKind: task.kind, document: doc as unknown as Prisma.InputJsonValue, digest,
        status: activeNow ? 'ACTIVE' : 'AWAITING_APPROVAL', direct: activeNow, approvalUrl: sub.body.approvalUrl, expiresAt, createdById: actor.userId,
        supersedesId: supersedes?.id ?? null,
      },
    });
    await this.audit.log({
      tenantId: biz.tenantId ?? undefined, customerId: dto.businessId, actorId: actor.userId, actorIp: actor.ip, action: 'AUTOMATION_POLICY_CREATED', resource: 'automation_policy', resourceId: row.id,
      meta: {
        name: dto.name, digest, approval: activeNow ? 'direct' : 'signed', action: `${action.id}@${action.version}`, task: taskInWords(task),
        ...(task.kind === 'script' ? { scriptVersionId: task.params.scriptVersionId, sha256: task.params.sha256, parameters: task.params.parameters }
          : task.kind === 'software' ? { entryId: task.display.entryId, packageId: task.params.packageId, version: task.params.version }
            : { restartRule: task.rule, ...(task.ignoreRemoteSession ? { ignoreRemoteSession: true } : {}) }),
        targets: targets.kind === 'computers' ? { kind: 'computers', endpointIds: targets.computers.map((c) => c.endpointId) }
          : targets.kind === 'group' ? { kind: 'group', groupId: targets.groupId, maxTargets: targets.maxTargets }
            : targets.kind === 'group_members' ? { kind: 'group_members', groupId: targets.groupId } : { kind: targets.kind },
        recurrence: dto.recurrence, offline: dto.offline, maxRunsPerOccurrence: dto.maxRunsPerOccurrence, expiresAt: doc.expiresAt, supersedes: supersedes?.id ?? null, reason: dto.reason,
      },
    });
    if (activeNow && row.supersedesId) await this.supersede(row, now);
    return row;
  }

  /**
   * What a schedule would be: its description and next runs, computed by the
   * same functions the signer runs, so the editor shows what the signer will
   * hold it to. Reads and writes nothing.
   */
  preview(raw: unknown, now = new Date()) {
    const p = PreviewDto.safeParse(raw);
    if (!p.success) this.bad('INVALID_REQUEST', p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const r = AutomationRecurrence.safeParse(p.data!.recurrence);
    if (!r.success) return { valid: false, message: r.error.issues.slice(0, 3).map((i) => `${['recurrence', ...i.path].join('.')}: ${i.message}`).join('; '), occurrences: [] };
    const until = p.data!.expiresInDays ? new Date(now.getTime() + p.data!.expiresInDays * 86_400_000) : undefined;
    const occurrences = automationNextOccurrences(now, r.data, 5, until);
    return { valid: true, kind: recurrenceKind(r.data), description: recurrenceInWords(r.data), occurrences, opensBeforeExpiry: until ? occurrences.length > 0 : null, hourlyEvery: HOURLY_EVERY };
  }

  private async scoped(actor: ActorContext, id: string): Promise<AutomationPolicy> {
    const r = PolicyIdRe.test(id) ? await this.prisma.automationPolicy.findUnique({ where: { id } }) : null;
    if (!r) throw new NotFoundException('Schedule not found');
    await this.acl.assertBusinessInScope(actor, r.customerId).catch(() => { throw new NotFoundException('Schedule not found'); });
    // Every computer it names must be visible to this person.
    const doc = r.document as unknown as AutomationDoc;
    if (doc.targets?.kind === 'computers') for (const c of doc.targets.computers) await this.acl.assertEndpointInScope(actor, c.endpointId).catch(() => { throw new NotFoundException('Schedule not found'); });
    return r;
  }

  private mayManage(actor: ActorContext, r: AutomationPolicy) {
    return actor.isPlatformAdmin || r.createdById === actor.userId || (!actor.technician && actor.businessId === r.customerId && this.acl.isBusinessOwner(actor));
  }

  /** One business's schedules (the reader's own; a Platform Admin who names none sees every business's newest). */
  async list(actor: ActorContext, businessId: string | undefined, now = new Date()) {
    if (businessId !== undefined && businessId !== '' && !Id.safeParse(businessId).success) this.bad('INVALID_REQUEST', 'businessId is not an id');
    const scope = this.acl.resolveScope(actor, businessId || null);
    if (scope) await this.acl.assertBusinessInScope(actor, scope);
    // 0.60: restart windows are shown where they are set (business, group and computer pages), not in this list.
    const rows = await this.prisma.automationPolicy.findMany({ where: { taskKind: { not: 'restart' }, ...(scope ? { customerId: scope } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
    const out = [];
    for (const r0 of rows) {
      try { await this.scoped(actor, r0.id); } catch { continue; }
      const r = await this.refresh(r0, now).catch(() => r0);
      const doc = r.document as unknown as AutomationDoc;
      const counts = await this.counts(r.id);
      out.push({
        id: r.id, name: r.name, businessId: r.customerId, businessName: doc.businessName, status: r.status, paused: !!r.pausedAt, taskKind: r.taskKind, task: taskInWords(doc.task),
        targets: doc.targets.kind === 'computers' ? `${doc.targets.computers.length} computer(s)` : targetsInWords(doc.targets, doc.businessName),
        schedule: recurrenceInWords(doc.recurrence), offline: offlineInWords(doc.offline),
        nextRun: r.status === 'ACTIVE' && !r.pausedAt ? automationNextOccurrence(now, doc.recurrence, r.expiresAt) : null,
        lastRun: counts.lastRun, succeeded: counts.succeeded, failed: counts.failed,
        expiresAt: r.expiresAt, createdAt: r.createdAt, supersedesId: r.supersedesId, supersededAt: r.supersededAt, lastProposal: r.lastProposal,
      });
    }
    return out;
  }

  /** Per-computer success and failure across every plan of a policy, and when it last ran. */
  private async counts(policyId: string) {
    const occ = await this.prisma.automationOccurrence.findMany({ where: { policyId, jobId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { jobId: true, createdAt: true } });
    const ts = occ.length ? await this.prisma.actionTarget.groupBy({ by: ['status'], where: { jobId: { in: occ.map((o) => o.jobId!) } }, _count: { _all: true } }) : [];
    const n = (s: string[]) => ts.filter((t) => s.includes(t.status)).reduce((a, t) => a + t._count._all, 0);
    return { lastRun: occ[0]?.createdAt ?? null, succeeded: n(['SUCCEEDED']), failed: n(['FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED', 'UNKNOWN']) };
  }

  async detail(actor: ActorContext, id: string, now = new Date()) {
    const r = await this.refresh(await this.scoped(actor, id), now).catch(async () => this.scoped(actor, id));
    const doc = r.document as unknown as AutomationDoc;
    const signer = this.signer.configured() ? await this.signer.automationStatus(r.id).catch(() => null) : null;
    const rows = await this.prisma.automationOccurrence.findMany({ where: { policyId: r.id }, orderBy: { createdAt: 'desc' }, take: 60 });
    const jobs = new Map((await this.prisma.actionJob.findMany({
      where: { id: { in: rows.map((x) => x.jobId).filter((x): x is string => !!x) } },
      select: { id: true, status: true, statusReason: true, notBefore: true, notAfter: true, targets: { select: { endpointId: true, status: true, outcome: true, statusReason: true, resultAt: true, endpoint: { select: { name: true, hostname: true } } } } },
    })).map((j) => [j.id, j]));
    const byKey = new Map<string, typeof rows>();
    for (const x of rows) { const l = byKey.get(x.occurrenceKey) ?? []; l.push(x); byKey.set(x.occurrenceKey, l); }
    const occurrences = [...byKey.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30).map(([key, list]) => {
      const plans = list.filter((x) => x.attempt > 0).sort((a, b) => a.attempt - b.attempt).map((x) => {
        const j = x.jobId ? jobs.get(x.jobId) : undefined;
        return {
          attempt: x.attempt, jobId: x.jobId, at: x.createdAt, code: x.code, message: x.message, skipped: x.skipped ?? [],
          jobStatus: j?.status ?? null, notBefore: j?.notBefore ?? null, notAfter: j?.notAfter ?? null,
          computers: (j?.targets ?? []).map((t) => ({ endpointId: t.endpointId, computer: t.endpoint.hostname ?? t.endpoint.name, status: t.status, outcome: t.outcome, reason: t.statusReason, at: t.resultAt })),
        };
      });
      const noteRow = list.find((x) => x.attempt === 0);
      const all = plans.flatMap((p) => p.computers);
      return {
        occurrence: key, plans, note: noteRow ? { code: noteRow.code, message: noteRow.message, skipped: noteRow.skipped ?? [], at: noteRow.createdAt } : null,
        succeeded: all.filter((c) => c.status === 'SUCCEEDED').length, failed: all.filter((c) => ['FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED', 'UNKNOWN'].includes(c.status)).length,
        pending: all.filter((c) => ['PENDING', 'DISPATCHED'].includes(c.status)).length,
      };
    });
    const counts = await this.counts(r.id);
    const live = r.status === 'ACTIVE' && !r.pausedAt;
    return {
      id: r.id, name: r.name, businessId: r.customerId, status: r.status, digest: r.digest, approvalUrl: r.approvalUrl, approvals: r.approvals ?? [], direct: r.direct,
      paused: r.pausedAt ? { at: r.pausedAt, byId: r.pausedById, reason: r.pauseReason } : null,
      expiresAt: r.expiresAt, createdAt: r.createdAt, createdById: r.createdById,
      revokedAt: r.revokedAt, revokeReason: r.revokeReason, signerConfirmedRevocation: !!r.signerRevokedAt,
      supersedesId: r.supersedesId, supersededAt: r.supersededAt,
      supersededBy: (await this.prisma.automationPolicy.findFirst({ where: { supersedesId: r.id }, select: { id: true, name: true, status: true } })) ?? null,
      document: doc, task: taskInWords(doc.task), schedule: recurrenceInWords(doc.recurrence), offline: offlineInWords(doc.offline),
      currentRun: live ? automationOccurrenceAt(now, doc.recurrence) : null,
      nextRun: live ? automationNextOccurrence(now, doc.recurrence, r.expiresAt) : null,
      upcoming: live ? automationNextOccurrences(now, doc.recurrence, 5, r.expiresAt) : [],
      lastRun: counts.lastRun, succeeded: counts.succeeded, failed: counts.failed,
      occurrences, lastProposal: r.lastProposal,
      signer: signer?.status === 200 ? { reachable: true, status: signer.body.status ?? null, signedPlans: signer.body.signedPlans ?? 0, refusals: signer.body.refusals ?? [] } : { reachable: false, status: null, signedPlans: null, refusals: [] },
      sweep: { enabled: AutomationService.sweepEnabled(), everySeconds: AutomationService.sweepSeconds() },
      mayManage: this.mayManage(actor, r) && !['REVOKED', 'REJECTED', 'EXPIRED'].includes(r.status),
    };
  }

  /** Pause: the sweep stops asking at once, and plans not yet delivered are canceled. Never needs a fresh sign-in (it only narrows). */
  async pause(actor: ActorContext, id: string, raw: unknown, now = new Date()) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'A reason of at least 3 characters is required.');
    const r = await this.scoped(actor, id);
    if (!this.mayManage(actor, r)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the schedule, a Business Owner of this business or a Platform Admin can pause it.' });
    if (!['AWAITING_APPROVAL', 'ACTIVE'].includes(r.status)) throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: `The schedule is ${r.status.toLowerCase().replace(/_/g, ' ')}.` });
    const c = await this.prisma.automationPolicy.updateMany({ where: { id, pausedAt: null }, data: { pausedAt: now, pausedById: actor.userId, pauseReason: dto.data!.reason } });
    if (!c.count) throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: 'The schedule is already paused.' });
    const stopped = await this.stopPlans(r, `schedule paused by ${actor.email ?? actor.userId}`);
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'AUTOMATION_POLICY_PAUSED', resource: 'automation_policy', resourceId: id, meta: { reason: dto.data!.reason, canceledPlans: stopped } });
    return this.detail(actor, id, now);
  }

  /** Resume: the controller asks for a fresh sign-in (automation.policy) first — it lets the schedule run again. */
  async resume(actor: ActorContext, id: string, now = new Date()) {
    const r = await this.scoped(actor, id);
    if (!this.mayManage(actor, r)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the schedule, a Business Owner of this business or a Platform Admin can resume it.' });
    if (!['AWAITING_APPROVAL', 'ACTIVE'].includes(r.status)) throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: `The schedule is ${r.status.toLowerCase().replace(/_/g, ' ')}; it cannot be resumed.` });
    const c = await this.prisma.automationPolicy.updateMany({ where: { id, pausedAt: { not: null }, status: { in: ['AWAITING_APPROVAL', 'ACTIVE'] } }, data: { pausedAt: null, pausedById: null, pauseReason: null } });
    if (!c.count) throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: 'The schedule is not paused.' });
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'AUTOMATION_POLICY_RESUMED', resource: 'automation_policy', resourceId: id, meta: { pausedAt: r.pausedAt, pauseReason: r.pauseReason } });
    return this.detail(actor, id, now);
  }

  /**
   * 0.60: withdraw a restart window's policy (it was changed, removed, or set
   * to no automatic restarts). Called only by RestartWindowsService, after its
   * own permission checks; withdrawing only narrows, so it asks no fresh
   * sign-in. Revoked here at once and on the signer now or on a later sweep.
   */
  async withdrawRestart(r: AutomationPolicy, reason: string, now = new Date()) {
    if (r.taskKind !== 'restart' || r.status === 'REVOKED') return;
    const why = reason.slice(0, 300);
    await this.prisma.automationPolicy.update({ where: { id: r.id }, data: { status: 'REVOKED', revokedAt: now, revokeReason: why } });
    const out = this.signer.configured() ? await this.signer.revokeAutomation(r.id, why).catch(() => null) : null;
    if (out?.status === 200) await this.prisma.automationPolicy.update({ where: { id: r.id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } });
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'AUTOMATION_POLICY_REVOKED', resource: 'automation_policy', resourceId: r.id, meta: { reason: why, from: r.status, restartWindow: true, signerConfirmed: out?.status === 200 } });
  }

  /** Revoke: the portal stops at once; the signer is told now and on every sweep until it confirms. One-way. */
  async revoke(actor: ActorContext, id: string, raw: unknown, now = new Date()) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'A reason of at least 3 characters is required.');
    const r = await this.scoped(actor, id);
    if (!this.mayManage(actor, r)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the schedule, a Business Owner of this business or a Platform Admin can revoke it.' });
    if (r.status === 'REVOKED') throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: 'The schedule is already revoked.' });
    const reason = dto.data!.reason;
    const u = await this.prisma.automationPolicy.update({ where: { id }, data: { status: 'REVOKED', revokedAt: now, revokedById: actor.userId, revokeReason: reason } });
    const stopped = await this.stopPlans(u, `schedule revoked by ${actor.email ?? actor.userId}`);
    let confirmed = false;
    const out = this.signer.configured() ? await this.signer.revokeAutomation(id, reason).catch(() => null) : null;
    if (out?.status === 200) { await this.prisma.automationPolicy.update({ where: { id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } }); confirmed = true; }
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'AUTOMATION_POLICY_REVOKED', resource: 'automation_policy', resourceId: id, meta: { reason, from: r.status, signerConfirmed: confirmed, canceledPlans: stopped } });
    return this.detail(actor, id, now);
  }
}
