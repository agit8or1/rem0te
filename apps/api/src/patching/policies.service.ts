import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type PatchDeployment, type PatchPolicy } from '@prisma/client';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { ContainmentService } from '../containment/containment.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { MAX_RING_TARGETS, MAX_UPDATES_PER_PLAN, UPDATE_INSTALL, UpdateReboot } from '../actions/catalog';
import {
  MAX_POLICY_DAYS, MAX_POLICY_RINGS, POLICY_SCHEMA, PolicyAllow, PolicyDoc, PolicyWindow,
  allowParams, localTime, nextOccurrence, occurrenceAt, policyAllowsUpdate, policyDigest, validatePolicyDoc,
} from '../actions/patch-policy';
import { MANAGER_LABEL, eligibility } from './posture';
import { PatchingService } from './patching.service';

/**
 * Automatic patch policies (v0.32).
 *
 * A policy is a bounded document — one business, named computers in fixed
 * rings with a one-computer canary, the update classes and severities it may
 * install, KBs it never installs, a maintenance window, soak and failure
 * threshold, a restart rule (0.34: never, or if required inside the
 * window), and an expiry at most 90 days out. Two people on
 * the approval signer's roster approve it there, with passkeys. After that
 * the signer signs each ring plan the portal proposes *only if the plan is
 * inside the document*: the portal cannot widen the computers, the classes,
 * the window or the ring order, nor skip the canary or its proof.
 *
 * This service proposes policies, mirrors their status from the signer,
 * revokes them, and runs the sweep that proposes ring plans inside an open
 * window. It has no approve route and cannot sign anything.
 *
 * Revocation is one-way and lives on the signer: the portal asks the signer
 * to revoke (and keeps asking until it confirms), and the signer's operator
 * can revoke from its own CLI. The portal's own row goes REVOKED at once, so
 * the portal stops proposing even while the signer is unreachable; the
 * signer refuses every later plan regardless of what the portal says.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const PolicyIdRe = /^[a-f0-9]{32}$/;

export const CreatePolicyDto = z.object({
  businessId: Id,
  name: z.string().trim().min(3).max(120),
  /** Endpoint ids. Ring 0 is the canary: exactly one. */
  rings: z.array(z.array(Id).min(1).max(MAX_RING_TARGETS)).min(1).max(MAX_POLICY_RINGS),
  allow: PolicyAllow,
  soakHours: z.number().int().min(0).max(168).default(24),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS).default(0),
  window: PolicyWindow,
  /** 0.34: never (the default), or restart if required inside the window. Signed into the policy. */
  reboot: UpdateReboot.default('never'),
  expiresInDays: z.number().int().min(1).max(MAX_POLICY_DAYS).default(30),
  reason: z.string().trim().min(3).max(500),
}).strict();

const ReasonDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/** Less than this left in a window and nothing new is proposed in it. */
const MIN_WINDOW_MS = 15 * 60_000;

type LastProposal = { at: string; windowKey: string | null; ok: boolean; code: string; message: string; deploymentId?: string | null; ring?: number | null; jobId?: string | null };

@Injectable()
export class PatchPolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PatchPolicies');
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
    private readonly updateTrust: UpdateTrustService,
    private readonly patching: PatchingService,
  ) {}

  // ── The sweep ─────────────────────────────────────────────────────────────

  static sweepEnabled() { return process.env.PATCH_POLICY_SWEEP !== 'off'; }
  static sweepSeconds() { return Math.max(2, Number(process.env.PATCH_POLICY_SWEEP_SECONDS) || 60); }

  onModuleInit() {
    if (!PatchPolicyService.sweepEnabled()) return;
    const every = PatchPolicyService.sweepSeconds() * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** One pass over every live policy. Never runs twice at once in this process; the database's unique (policy, window) stops a second process. */
  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.prisma.patchPolicy.findMany({
        where: { OR: [{ status: { in: ['AWAITING_APPROVAL', 'ACTIVE'] } }, { status: 'REVOKED', signerRevokedAt: null }] },
        orderBy: { createdAt: 'asc' }, take: 200,
      });
      for (const r0 of rows) {
        try {
          const r = await this.refresh(r0, now);
          if (r.status === 'ACTIVE') await this.propose(r, now);
        } catch (e) {
          this.logger.warn(`policy ${r0.id}: ${(e as Error).message}`);
        }
      }
    } finally { this.busy = false; }
  }

  /** Mirror the signer's view of a policy; keep asking it to revoke until it confirms. */
  private async refresh(r: PatchPolicy, now = new Date()): Promise<PatchPolicy> {
    if (!this.signer.configured()) return r;
    if (r.status === 'REVOKED') {
      if (r.signerRevokedAt) return r;
      const out = await this.signer.revokePolicy(r.id, r.revokeReason ?? 'revoked at the portal').catch(() => null);
      if (out?.status !== 200) return r;
      const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } });
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_POLICY_UPDATED', resource: 'patch_policy', resourceId: r.id, meta: { signerConfirmedRevocation: true } });
      return u;
    }
    if (!['AWAITING_APPROVAL', 'ACTIVE'].includes(r.status)) return r;
    const s = await this.signer.policyStatus(r.id).catch(() => null);
    if (!s || s.status !== 200) {
      // An expiry needs no signer to be true.
      if (r.expiresAt <= now) return this.setStatus(r, 'EXPIRED', { reason: 'expired' });
      return r;
    }
    if (s.body.digest !== r.digest) {
      // Never take a status for a document other than the one stored here.
      this.logger.error(`policy ${r.id}: the signer holds a different document (digest mismatch); not mirroring its status`);
      return r;
    }
    const st = s.body.status as PatchPolicy['status'] | undefined;
    const approvals = (s.body.approvals ?? []) as unknown as Prisma.InputJsonValue;
    if (st === 'REVOKED') {
      // Revoked by the signer's own operator: the portal follows.
      const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { status: 'REVOKED', revokedAt: new Date(s.body.revokedAt ?? now), revokeReason: r.revokeReason ?? 'revoked on the approval signer', signerRevokedAt: new Date(s.body.revokedAt ?? now), approvals } });
      await this.stopDeployments(u, 'the policy was revoked on the approval signer');
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_POLICY_REVOKED', resource: 'patch_policy', resourceId: r.id, meta: { by: 'approval signer' } });
      return u;
    }
    if (st && st !== r.status && ['AWAITING_APPROVAL', 'ACTIVE', 'REJECTED', 'EXPIRED'].includes(st)) return this.setStatus(r, st, { approvals: s.body.approvals ?? [] }, approvals);
    if (JSON.stringify(r.approvals ?? []) !== JSON.stringify(s.body.approvals ?? [])) return this.prisma.patchPolicy.update({ where: { id: r.id }, data: { approvals } });
    return r;
  }

  private async setStatus(r: PatchPolicy, status: PatchPolicy['status'], meta: Record<string, unknown>, approvals?: Prisma.InputJsonValue) {
    const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { status, ...(approvals !== undefined ? { approvals } : {}) } });
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_POLICY_UPDATED', resource: 'patch_policy', resourceId: r.id, meta: { from: r.status, status, ...meta } });
    return u;
  }

  private async record(r: PatchPolicy, p: Omit<LastProposal, 'at'>, audit: boolean, now: Date) {
    const last = r.lastProposal as LastProposal | null;
    const same = !!last && last.windowKey === p.windowKey && last.code === p.code && last.ok === p.ok && (last.ring ?? null) === (p.ring ?? null) && (last.jobId ?? null) === (p.jobId ?? null);
    if (same) return;
    await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { lastProposal: { at: now.toISOString(), ...p } as unknown as Prisma.InputJsonValue } });
    r.lastProposal = { at: now.toISOString(), ...p } as unknown as Prisma.JsonValue;
    if (audit) {
      await this.audit.log({
        tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: r.createdById,
        action: p.ok ? 'PATCH_POLICY_PROPOSED' : 'PATCH_POLICY_REFUSED', resource: 'patch_policy', resourceId: r.id,
        meta: { windowKey: p.windowKey, code: p.code, message: p.message, deploymentId: p.deploymentId ?? null, ring: p.ring ?? null, jobId: p.jobId ?? null },
      });
    }
  }

  /** Inside an open window: start this window's deployment, or move an open one on by one ring. */
  private async propose(r: PatchPolicy, now: Date) {
    const doc = PolicyDoc.parse(r.document);
    const occ = occurrenceAt(now, doc.window);
    if (!occ) return;
    const windowKey = occ.start.toISOString();
    const notAfter = new Date(Math.min(occ.end.getTime(), now.getTime() + 24 * 3_600_000, Date.parse(doc.expiresAt)));
    if (notAfter.getTime() - now.getTime() < MIN_WINDOW_MS) return;
    const rec = (ok: boolean, code: string, message: string, extra: Partial<LastProposal> = {}, audit = true) => this.record(r, { windowKey, ok, code, message, ...extra }, audit, now);

    if (await this.containment.blocking('actions', r.customerId)) return rec(false, 'contained', 'Containment pauses actions for this business; nothing is proposed until it is lifted.');
    const actor = await this.actors.contextFor(doc.createdBy.userId, r.tenantId ?? '', r.customerId);
    if (!actor) return rec(false, 'author_inactive', `${doc.createdBy.name}, who created the policy, is no longer active or no longer reaches this business. Plans are requested on the author's behalf, so nothing is proposed. Revoke it and create a new one.`);

    // A deployment already open under this policy is moved on, across windows.
    let d: PatchDeployment | null = await this.prisma.patchDeployment.findFirst({ where: { policyId: r.id, status: { in: ['ACTIVE', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } });
    if (d?.status === 'PAUSED') return rec(false, 'deployment_paused', `Deployment "${d.name}" is paused${d.pausedReason ? `: ${d.pausedReason}` : ''}. Resume or cancel it; nothing new is proposed meanwhile.`, { deploymentId: d.id }, false);
    if (!d) {
      if (await this.prisma.patchDeployment.findFirst({ where: { policyId: r.id, windowKey }, select: { id: true } })) return; // this window had its deployment
      d = await this.startDeployment(r, doc, actor, windowKey, now, rec);
      if (!d) return;
    }
    await this.nextRing(r, doc, actor, d, windowKey, now, notAfter, rec);
  }

  /** The canary's offered, installable, policy-allowed updates become this window's deployment. */
  private async startDeployment(r: PatchPolicy, doc: PolicyDoc, actor: ActorContext, windowKey: string, now: Date, rec: (ok: boolean, code: string, message: string, extra?: Partial<LastProposal>, audit?: boolean) => Promise<void>): Promise<PatchDeployment | null> {
    const canary = doc.rings[0][0];
    const why = await this.notReady(actor, canary);
    if (why) { await rec(false, 'canary_not_ready', `The canary, ${canary.hostname}: ${why}`); return null; }
    const posture = (await this.patching.postures([canary.endpointId])).get(canary.endpointId)!;
    const updates = posture.updates.filter((u) => eligibility(u).ok && policyAllowsUpdate(doc.allow, u).ok).slice(0, MAX_UPDATES_PER_PLAN);
    if (!updates.length) { await rec(true, 'nothing_to_install', `Windows Update offers the canary nothing this policy installs (scan of ${posture.scannedAt}).`, {}, false); return null; }
    const local = localTime(new Date(windowKey), doc.window.timezone);
    const date = `${local.y}-${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
    try {
      return await this.patching.build(actor, {
        businessId: r.customerId, name: `${doc.name} — ${date}`.slice(0, 120),
        updates: updates.map((u) => ({ updateId: u.updateId, revision: u.revision })),
        rings: doc.rings.map((ring) => ring.map((c) => c.endpointId)),
        soakHours: doc.soakHours, failureThreshold: doc.failureThreshold, windowHours: 24, reboot: doc.reboot,
      }, 'POLICY', { policyId: r.id, windowKey, createdById: doc.createdBy.userId });
    } catch (e) {
      // Another sweep (another process) made this window's deployment first.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      const b = (e as { getResponse?: () => { code?: string; message?: string } }).getResponse?.();
      await rec(false, b?.code ?? 'deployment_refused', b?.message ?? (e as Error).message);
      return null;
    }
  }

  private async nextRing(r: PatchPolicy, doc: PolicyDoc, actor: ActorContext, d: PatchDeployment, windowKey: string, now: Date, notAfter: Date, rec: (ok: boolean, code: string, message: string, extra?: Partial<LastProposal>, audit?: boolean) => Promise<void>) {
    const detail = await this.patching.detail(actor, d.id, now);
    if (detail.status !== 'ACTIVE') return;
    const { ring, canRequest, why } = detail.next;
    if (ring === null || !canRequest) return rec(true, 'waiting', why, { deploymentId: d.id, ring }, false);
    // A computer not ready now is left out of this ring's plan, with why — it
    // is never swapped for another, and the signer checks each one against
    // the approved identity.
    const exclude: { endpointId: string; why: string }[] = [];
    if (ring > 0) {
      for (const c of doc.rings[ring]) {
        const no = await this.notReady(actor, c);
        if (no) exclude.push({ endpointId: c.endpointId, why: no.slice(0, 200) });
      }
      if (exclude.length === doc.rings[ring].length) return rec(false, 'ring_not_ready', `No computer in ring ${ring} is ready: ${exclude.map((x) => x.why).slice(0, 2).join('; ')}`, { deploymentId: d.id, ring });
    } else {
      const no = await this.notReady(actor, doc.rings[0][0]);
      if (no) return rec(false, 'canary_not_ready', `The canary, ${doc.rings[0][0].hostname}: ${no}`, { deploymentId: d.id, ring });
    }
    try {
      const out = await this.patching.requestRing(actor, d.id, ring, { reason: `Patch policy "${doc.name}", window ${windowKey}`.slice(0, 400), exclude }, {
        policyId: r.id, name: doc.name, digest: r.digest, allow: allowParams(doc.allow), window: { notBefore: now, notAfter },
      });
      await rec(true, 'signed', `Ring ${ring} of "${d.name}" was signed under the policy${exclude.length ? `, leaving out ${exclude.length} computer(s) not ready` : ''}.`, { deploymentId: d.id, ring, jobId: out.job.id });
    } catch (e) {
      const b = (e as { getResponse?: () => { code?: string; signerCode?: string | null; message?: string } }).getResponse?.();
      const code = b?.signerCode ?? b?.code ?? 'request_failed';
      await rec(false, code, b?.message ?? (e as Error).message, { deploymentId: d.id, ring });
      if (code === 'ring_retry_limit') {
        // The signer will not sign this ring under the policy again. Close the
        // deployment so the next window starts afresh with a new canary run.
        await this.prisma.patchDeployment.update({ where: { id: d.id }, data: { status: 'CANCELED', pausedReason: b?.message ?? 'retry limit' } });
        await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: d.id, meta: { status: 'CANCELED', reason: 'ring_retry_limit', policyId: r.id } });
      }
    }
  }

  /** Why this policy computer cannot be in a plan right now, or null. */
  private async notReady(actor: ActorContext, c: PolicyDoc['rings'][number][number]): Promise<string | null> {
    const ep = await this.actions.endpointFor(c.endpointId);
    if (!ep || ep.status === 'ARCHIVED') return 'it is no longer enrolled.';
    if (ep.rustdeskNode?.rustdeskId !== c.rustdeskId || ep.rustdeskNode?.agentSecretHash !== c.deviceSecretSha256) return 'it was re-enrolled since the policy was approved, so it is not the computer that was approved.';
    const d = await this.access.evaluateAction(actor, ep, 'high');
    if (!d.ok) return d.message;
    const nr = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
    if (nr) return nr;
    const p = (await this.patching.postures([ep.id])).get(ep.id);
    if (!p) return 'it has not reported a signed Windows Update scan.';
    if (p.managers.length) return `its updates are managed by ${p.managers.map((m) => MANAGER_LABEL[m]).join(', ')}.`;
    const blocking = await this.actions.blocking(ep.id, UPDATE_INSTALL.id);
    if (blocking) return `an earlier install on it is ${blocking.status.toLowerCase().replace(/_/g, ' ')}.`;
    return null;
  }

  // ── People ────────────────────────────────────────────────────────────────

  private bad(code: string, message: string): never { throw new BadRequestException({ code, message }); }

  async create(actor: ActorContext, raw: unknown, now = new Date()) {
    const parsed = CreatePolicyDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data;
    if (!this.signer.configured()) throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_NOT_CONFIGURED', message: 'Patch policies need the approval signer (APPROVAL_SIGNER_INTERNAL_URL). See Patching setup.' });
    const caps = await this.signer.capabilities();
    if (caps.status !== 200 || caps.body.patchPolicies !== 1) throw new ConflictException({ code: 'SIGNER_TOO_OLD', message: 'The approval signer does not support patch policies. Install the 0.32 signer.' });

    const all = dto.rings.flat();
    if (new Set(all).size !== all.length) this.bad('BAD_RINGS', 'A computer can be in one ring only.');
    if (dto.rings[0].length !== 1) this.bad('BAD_RINGS', 'Ring 0 is the canary: exactly one computer.');
    const rings: PolicyDoc['rings'] = [];
    let businessName = '';
    let tenantId: string | null = null;
    for (const [i, ring] of dto.rings.entries()) {
      const out: PolicyDoc['rings'][number] = [];
      for (const id of ring) {
        await this.acl.assertEndpointInScope(actor, id);
        const ep = await this.actions.endpointFor(id);
        if (!ep || ep.customerId !== dto.businessId || !ep.customer || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
        const name = (ep.hostname ?? ep.name).slice(0, 64);
        const dec = await this.access.evaluateAction(actor, ep, 'high');
        if (!dec.ok) throw new ForbiddenException({ code: dec.reason.toUpperCase(), message: `${name}: ${dec.message}`, endpointId: id });
        if (!ep.rustdeskNode?.rustdeskId || !ep.rustdeskNode.agentSecretHash) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: this computer has no enrolled device identity.`, endpointId: id });
        if (ep.updateChannel !== 'signed') throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: runs the standard agent. Move it to the signed channel first.`, endpointId: id });
        if (i === 0) {
          const nr = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
          if (nr) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name} (the canary): ${nr}`, endpointId: id });
        }
        businessName = ep.customer.name.slice(0, 120);
        tenantId = ep.tenantId;
        out.push({ endpointId: id, hostname: name, rustdeskId: ep.rustdeskNode.rustdeskId, deviceSecretSha256: ep.rustdeskNode.agentSecretHash });
      }
      rings.push(out);
    }
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true, email: true } });
    const expiresAt = new Date(now.getTime() + dto.expiresInDays * 86_400_000);
    const doc: PolicyDoc = {
      schema: POLICY_SCHEMA, policyId: randomBytes(16).toString('hex'), name: dto.name, businessId: dto.businessId, businessName,
      rings, allow: dto.allow, soakHours: dto.soakHours, failureThreshold: dto.failureThreshold, window: dto.window, reboot: dto.reboot,
      createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      createdBy: { userId: actor.userId, name: ([user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || actor.userId).slice(0, 120) },
      reason: dto.reason,
    };
    const shape = PolicyDoc.safeParse(doc);
    if (!shape.success) this.bad('INVALID_REQUEST', shape.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = validatePolicyDoc(doc, now);
    if (!v.ok) this.bad(v.reason.toUpperCase(), v.message);
    const digest = policyDigest(doc);
    const sub = await this.signer.submitPolicy(doc);
    if (sub.status !== 201 || sub.body.digest !== digest || !sub.body.approvalUrl) {
      throw new ConflictException({ code: 'APPROVAL_SIGNER_REFUSED', signerCode: sub.body.error ?? null, message: sub.body.message ?? sub.body.error ?? 'The approval signer refused the policy.' });
    }
    const row = await this.prisma.patchPolicy.create({
      data: {
        id: doc.policyId, tenantId, customerId: dto.businessId, name: dto.name, document: doc as unknown as Prisma.InputJsonValue, digest,
        status: 'AWAITING_APPROVAL', approvalUrl: sub.body.approvalUrl, expiresAt, createdById: actor.userId,
      },
    });
    await this.audit.log({
      tenantId: tenantId ?? undefined, customerId: dto.businessId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_POLICY_CREATED', resource: 'patch_policy', resourceId: row.id,
      meta: { name: dto.name, digest, rings: rings.map((x) => x.length), allow: allowParams(dto.allow), window: dto.window, soakHours: dto.soakHours, failureThreshold: dto.failureThreshold, reboot: dto.reboot, expiresAt: doc.expiresAt, reason: dto.reason },
    });
    return this.detail(actor, row.id, now);
  }

  private async scoped(actor: ActorContext, id: string): Promise<PatchPolicy> {
    const r = PolicyIdRe.test(id) ? await this.prisma.patchPolicy.findUnique({ where: { id } }) : null;
    if (!r) throw new NotFoundException('Policy not found');
    // Every computer it names must be visible to this person.
    const doc = r.document as unknown as PolicyDoc;
    for (const c of doc.rings.flat()) await this.acl.assertEndpointInScope(actor, c.endpointId).catch(() => { throw new NotFoundException('Policy not found'); });
    return r;
  }

  async list(actor: ActorContext, businessId: string, now = new Date()) {
    if (!Id.safeParse(businessId).success) this.bad('INVALID_REQUEST', 'businessId is required');
    const rows = await this.prisma.patchPolicy.findMany({ where: { customerId: businessId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const out = [];
    for (const r0 of rows) {
      try { await this.scoped(actor, r0.id); } catch { continue; }
      const r = await this.refresh(r0, now).catch(() => r0);
      const doc = r.document as unknown as PolicyDoc;
      out.push({
        id: r.id, name: r.name, status: r.status, expiresAt: r.expiresAt, createdAt: r.createdAt,
        computers: doc.rings.flat().length, rings: doc.rings.length, window: doc.window,
        nextWindow: r.status === 'ACTIVE' ? nextOccurrence(now, doc.window, r.expiresAt) : null,
        lastProposal: r.lastProposal,
      });
    }
    return out;
  }

  async detail(actor: ActorContext, id: string, now = new Date()) {
    const r = await this.refresh(await this.scoped(actor, id), now).catch(async () => this.scoped(actor, id));
    const doc = r.document as unknown as PolicyDoc;
    const signer = this.signer.configured() ? await this.signer.policyStatus(r.id).catch(() => null) : null;
    const deployments = await this.prisma.patchDeployment.findMany({ where: { policyId: r.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, name: true, status: true, windowKey: true, pausedReason: true, createdAt: true } });
    return {
      id: r.id, name: r.name, businessId: r.customerId, status: r.status, digest: r.digest, approvalUrl: r.approvalUrl,
      approvals: r.approvals ?? [], expiresAt: r.expiresAt, createdAt: r.createdAt, createdById: r.createdById,
      revokedAt: r.revokedAt, revokeReason: r.revokeReason, signerConfirmedRevocation: !!r.signerRevokedAt,
      document: doc,
      currentWindow: r.status === 'ACTIVE' ? occurrenceAt(now, doc.window) : null,
      nextWindow: r.status === 'ACTIVE' ? nextOccurrence(now, doc.window, r.expiresAt) : null,
      lastProposal: r.lastProposal,
      signer: signer?.status === 200 ? { reachable: true, status: signer.body.status ?? null, signedPlans: signer.body.signedPlans ?? 0, refusals: signer.body.refusals ?? [] } : { reachable: false, status: null, signedPlans: null, refusals: [] },
      deployments,
      sweep: { enabled: PatchPolicyService.sweepEnabled(), everySeconds: PatchPolicyService.sweepSeconds() },
      mayRevoke: this.mayManage(actor, r) && !['REVOKED', 'REJECTED', 'EXPIRED'].includes(r.status),
    };
  }

  private mayManage(actor: ActorContext, r: PatchPolicy) {
    return actor.isPlatformAdmin || r.createdById === actor.userId || (!actor.technician && actor.businessId === r.customerId && this.acl.isBusinessOwner(actor));
  }

  /** Revoke: the portal stops at once; the signer is told now and on every sweep until it confirms. One-way. */
  async revoke(actor: ActorContext, id: string, raw: unknown, now = new Date()) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'A reason of at least 3 characters is required.');
    const r = await this.scoped(actor, id);
    if (!this.mayManage(actor, r)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the policy, a Business Owner of this business or a Platform Admin can revoke it.' });
    if (r.status === 'REVOKED') throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: 'The policy is already revoked.' });
    const reason = dto.data!.reason;
    const u = await this.prisma.patchPolicy.update({ where: { id }, data: { status: 'REVOKED', revokedAt: now, revokedById: actor.userId, revokeReason: reason } });
    const stopped = await this.stopDeployments(u, `policy revoked by ${actor.email ?? actor.userId}`);
    let confirmed = false;
    const out = this.signer.configured() ? await this.signer.revokePolicy(id, reason).catch(() => null) : null;
    if (out?.status === 200) { await this.prisma.patchPolicy.update({ where: { id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } }); confirmed = true; }
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_POLICY_REVOKED', resource: 'patch_policy', resourceId: id, meta: { reason, from: r.status, signerConfirmed: confirmed, canceledPlans: stopped.plans, canceledDeployments: stopped.deployments } });
    return this.detail(actor, id, now);
  }

  /** Cancel what has not reached a computer and close the policy's open deployments. Anything delivered runs to its own result. */
  private async stopDeployments(r: PatchPolicy, why: string) {
    const deps = await this.prisma.patchDeployment.findMany({ where: { policyId: r.id, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } });
    let plans = 0;
    for (const j of await this.prisma.actionJob.findMany({ where: { deployment: { policyId: r.id }, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, select: { id: true, status: true, tenantId: true, customerId: true } })) {
      if (j.status === 'AWAITING_APPROVAL') await this.signer.cancel(j.id).catch(() => undefined);
      const c = await this.prisma.actionJob.updateMany({ where: { id: j.id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELED', statusReason: why.slice(0, 200) } });
      if (!c.count) continue;
      plans++;
      await this.prisma.actionTarget.updateMany({ where: { jobId: j.id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: 'plan canceled' } });
      await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_CANCELED', resource: 'action_job', resourceId: j.id, meta: { reason: why, policyId: r.id } });
    }
    for (const d of deps) {
      await this.prisma.patchDeployment.update({ where: { id: d.id }, data: { status: 'CANCELED', pausedReason: why.slice(0, 200) } });
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: d.id, meta: { status: 'CANCELED', reason: why, policyId: r.id } });
    }
    return { plans, deployments: deps.length };
  }

  // ── Pre-flight (Platform Admin) ───────────────────────────────────────────

  /**
   * Which production prerequisites for signed patching are missing, from real
   * state only: the served repository, the signer's own answers, and the
   * computers' reported builds. Nothing here is a stored checkbox.
   */
  async preflight(actor: ActorContext) {
    if (!actor.isPlatformAdmin) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'The patching pre-flight is for Platform Admins.' });
    type Check = { id: string; ok: boolean; title: string; detail: string; fix: string | null; step: number };
    const checks: Check[] = [];
    const add = (c: Check) => checks.push(c);

    const agent = this.updateTrust.agentTarget();
    add({ id: 'signed_release', step: 1, ok: !!agent, title: 'A signed agent release is published',
      detail: agent ? `windows/rem0te-agent.exe is served, sha256 ${agent.sha256.slice(0, 16)}…` : 'The update repository serves no signed agent build (windows/rem0te-agent.exe), so no plan can name one.',
      fix: agent ? null : 'Publish a signed release with rem0te-release on the release machine (docs/update-signing.md).' });

    let trustedKids: string[] = [];
    const kf = this.updateTrust.targetFile('approval/keys.json');
    if (kf) { try { const j = JSON.parse(readFileSync(kf.path, 'utf8')) as { keys?: { kid?: string }[] }; trustedKids = (j.keys ?? []).map((k) => String(k.kid)); } catch { /* reported below */ } }

    const configured = this.signer.configured();
    add({ id: 'signer_configured', step: 4, ok: configured, title: 'The portal knows where the approval signer is',
      detail: configured ? `APPROVAL_SIGNER_INTERNAL_URL is ${this.signer.base()}` : 'APPROVAL_SIGNER_INTERNAL_URL is unset or not a loopback http address.',
      fix: configured ? null : 'Install the signer (step 3) and set APPROVAL_SIGNER_INTERNAL_URL in the API environment.' });

    let caps: { patchPolicies?: number; kid?: string; roster?: { approvers: number } } | null = null;
    let reachable = false;
    if (configured) {
      const c = await this.signer.capabilities().catch(() => null);
      reachable = !!c && (c.status === 200 || c.status === 404);
      caps = c?.status === 200 ? c.body : null;
    }
    add({ id: 'signer_reachable', step: 4, ok: reachable, title: 'The approval signer answers',
      detail: !configured ? 'Not configured.' : reachable ? 'Its internal listener answered.' : 'It did not answer on its internal listener.',
      fix: reachable ? null : 'Start the approval signer service and check its internal listen address matches.' });
    add({ id: 'signer_policies', step: 3, ok: caps?.patchPolicies === 1, title: 'The signer supports patch policies',
      detail: caps?.patchPolicies === 1 ? 'Signer 0.32 or later.' : reachable ? 'The signer answering is older than 0.32.' : 'Unknown: the signer is not reachable.',
      fix: caps?.patchPolicies === 1 ? null : 'Install the 0.32 approval signer (apps/api/scripts/build-approval-signer.mjs).' });
    const kidOk = !!caps?.kid && trustedKids.includes(caps.kid);
    add({ id: 'signer_key_published', step: 3, ok: kidOk, title: 'Agents trust the signer\'s key',
      detail: !kf ? 'approval/keys.json is not in the signed repository, so agents trust no approval key.' : !caps?.kid ? `approval/keys.json lists ${trustedKids.length} key(s); the signer's key id is unknown.` : kidOk ? `approval/keys.json lists the signer's key ${caps.kid}.` : `approval/keys.json does not list the signer's key ${caps.kid}; agents would refuse every plan it signs.`,
      fix: kidOk ? null : 'Print the signer\'s keys.json (approval-signer keys) and publish it as approval/keys.json with rem0te-release.' });
    const approvers = caps?.roster?.approvers ?? 0;
    add({ id: 'approvers', step: 5, ok: approvers >= 2, title: 'At least two approvers are enrolled',
      detail: caps ? `${approvers} approver(s) on the roster.` : 'Unknown: the signer is not reachable.',
      fix: approvers >= 2 ? null : 'Enrol two approvers on the signer, with the fingerprint ceremony (docs/approved-actions.md, Setting it up).' });

    const key = `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`;
    const [windows, signed, capable, current] = await Promise.all([
      this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, platform: { contains: 'windows', mode: 'insensitive' } } }).catch(() => this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' } } })),
      this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, updateChannel: 'signed' } }),
      this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, updateChannel: 'signed', agentActions: { has: key } } }),
      agent ? this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, updateChannel: 'signed', agentActions: { has: key }, agentSha256: agent.sha256 } }) : Promise.resolve(0),
    ]);
    add({ id: 'computers_signed', step: 2, ok: current > 0, title: 'Computers are on the signed channel, on the published build',
      detail: `${signed} of ${windows} computer(s) on the signed channel; ${capable} report the update action; ${current} run the published build.`,
      fix: current > 0 ? null : 'Migrate computers to the signed channel and let them update to the published build (docs/update-signing.md).' });
    const withPosture = await this.prisma.endpointInventory.count({ where: { patchScannedAt: { not: null }, endpoint: { updateChannel: 'signed', status: { not: 'ARCHIVED' } } } });
    add({ id: 'computers_scanned', step: 2, ok: withPosture > 0, title: 'Signed computers have reported a Windows Update scan',
      detail: `${withPosture} signed computer(s) have a signed scan.`,
      fix: withPosture > 0 ? null : 'Press Scan now on a signed computer\'s Patches tab.' });
    const activePolicies = await this.prisma.patchPolicy.count({ where: { status: 'ACTIVE' } });
    add({ id: 'sweep', step: 6, ok: PatchPolicyService.sweepEnabled(), title: 'The policy sweep is running',
      detail: PatchPolicyService.sweepEnabled() ? `Every ${PatchPolicyService.sweepSeconds()} s; ${activePolicies} active polic${activePolicies === 1 ? 'y' : 'ies'}.` : 'PATCH_POLICY_SWEEP=off: approved policies are never acted on.',
      fix: PatchPolicyService.sweepEnabled() ? null : 'Remove PATCH_POLICY_SWEEP=off from the API environment.' });
    return { ready: checks.every((c) => c.ok), checks, fixtureTestedOnly: true };
  }
}

export type { PolicyWindow };
