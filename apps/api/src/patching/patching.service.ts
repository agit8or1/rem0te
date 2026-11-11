import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ActionJob, type ActionTarget, type PatchDeployment } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { MAX_RING_TARGETS, MAX_UPDATES_PER_PLAN, UPDATE_ID_RE, UPDATE_INSTALL } from '../actions/catalog';
import { evaluateRingGate, targetStates, toEvidenceTarget, type Gate, type GateTarget, type RingEvidence } from '../actions/patch-policy';
import { CLASSIFICATIONS, MANAGER_LABEL, Posture, eligibility, idKey } from './posture';
import { patchSummaryFor, type PatchSummary } from './summary-db';

/**
 * Staged Windows patching (v0.27).
 *
 * A deployment is a fixed set of Windows updates and a fixed list of rings.
 * Ring 0 is the canary: one computer. Each ring is requested separately and
 * becomes one signed plan (windows.update.install@1) that the approval roster
 * approves on its own, with two approvers — so the portal can never widen a
 * rollout past what people approved, and a compromised portal cannot skip a
 * ring.
 *
 * The next ring can be requested only when the previous one passed its gate:
 *   - every computer in it answered, and none is uncertain and unreconciled;
 *   - no more failed computers than the deployment's threshold (more pauses it);
 *   - for the canary, every update is confirmed EFFECTIVE by a scan taken
 *     after the install (and after any restart) — "installed" is not enough;
 *   - the soak time has passed since the ring's last result.
 */

const Ident = z.object({ updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int().min(1).max(1_000_000) }).strict();
const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const CreateDeploymentDto = z.object({
  businessId: Id,
  name: z.string().trim().min(3).max(120),
  updates: z.array(Ident).min(1).max(MAX_UPDATES_PER_PLAN),
  rings: z.array(z.array(Id).min(1).max(MAX_RING_TARGETS)).min(1).max(5),
  soakHours: z.number().int().min(0).max(168).default(24),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS).default(0),
  windowHours: z.number().int().min(1).max(24).default(8),
}).strict();

export const RequestRingDto = z.object({
  reason: z.string().trim().min(3).max(400),
  startsInMinutes: z.number().int().min(0).max(24 * 60).default(0),
  /** Computers of this ring to leave out, each with why. */
  exclude: z.array(z.object({ endpointId: Id, why: z.string().trim().min(3).max(200) }).strict()).max(MAX_RING_TARGETS).default([]),
}).strict();

const ReasonDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/**
 * 0.32: "Install updates" from one computer's Patches tab. It becomes a
 * one-computer deployment — a single canary ring — that goes to the approval
 * roster like any other: two approvals, never the requester. There is no
 * direct per-computer request (ACTION_NOT_DIRECT still holds).
 */
export const InstallDto = z.object({
  updates: z.array(Ident).min(1).max(MAX_UPDATES_PER_PLAN),
  /** The only rule this release has: computers are never restarted. */
  reboot: z.literal('never'),
  reason: z.string().trim().min(3).max(400),
  windowHours: z.number().int().min(1).max(24).default(8),
  startsInMinutes: z.number().int().min(0).max(24 * 60).default(0),
}).strict();

export type DeploymentUpdate = { updateId: string; revision: number; kb: string | null; title: string; className: string | null; severity: string | null };
type Ring = { endpointIds: string[] };
type Job = ActionJob & { targets: ActionTarget[] };
export type { Gate };

/** Built by the patch-policy sweep (0.32); never from a request body. */
export interface PolicyOrigin { policyId: string; windowKey: string; createdById: string }
/** What a ring request under a policy adds: the policy, the exact window, and the filter the agent applies. */
export interface UnderPolicy { policyId: string; name: string; digest: string; allow: Record<string, string[]>; window: { notBefore: Date; notAfter: Date } }

@Injectable()
export class PatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly policy: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
  ) {}

  private bad(code: string, message: string, extra: Record<string, unknown> = {}): never {
    throw new BadRequestException({ code, message, ...extra });
  }

  async postures(endpointIds: string[]): Promise<Map<string, Posture>> {
    const rows = await this.prisma.endpointInventory.findMany({ where: { endpointId: { in: endpointIds } }, select: { endpointId: true, patchPosture: true } });
    const out = new Map<string, Posture>();
    for (const r of rows) {
      const p = Posture.safeParse(r.patchPosture);
      if (p.success) out.set(r.endpointId, p.data);
    }
    return out;
  }

  // ── One computer ──────────────────────────────────────────────────────────

  async endpointPatches(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const [inv, ep] = await Promise.all([
      this.prisma.endpointInventory.findUnique({ where: { endpointId }, select: { patchPosture: true, patchScannedAt: true, pendingUpdates: true, rebootRequired: true, updatesCheckedAt: true } }),
      this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { updateChannel: true, agentActions: true, patchScanRequestedAt: true } }),
    ]);
    const p = Posture.safeParse(inv?.patchPosture);
    const posture = p.success ? p.data : null;
    return {
      summary: await this.summaryFor(endpointId),
      supported: ep?.updateChannel === 'signed' && !!ep.agentActions?.includes(`${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`),
      scannedAt: inv?.patchScannedAt ?? null,
      scanRequestedAt: ep?.patchScanRequestedAt ?? null,
      scanPending: !!ep?.patchScanRequestedAt && (!inv?.patchScannedAt || ep.patchScanRequestedAt > inv.patchScannedAt),
      error: posture?.error ?? null,
      managers: (posture?.managers ?? []).map((m) => ({ id: m, label: MANAGER_LABEL[m] })),
      autoUpdate: posture?.autoUpdate ?? null,
      reboot: posture?.reboot ?? null,
      updates: (posture?.updates ?? []).map((u) => ({ ...u, ...(() => { const e = eligibility(u); return { installable: e.ok, notInstallableBecause: e.reason }; })() })),
      history: posture?.history ?? [],
      /** 0.32: whether "Install updates" is offered, and if not, why and what to do instead. */
      install: await this.installState(actor, endpointId),
      // Every agent, signed or not, answers the inventory's UPDATE_SCAN (every
      // 12 hours, or on Scan now). Without a signed posture this is what the
      // tab shows: read-only, and never a source for a deployment.
      basic: posture ? null : {
        checkedAt: inv?.updatesCheckedAt ?? null,
        rebootRequired: inv?.rebootRequired ?? null,
        updates: Array.isArray(inv?.pendingUpdates) ? (inv.pendingUpdates as { title: string; kb: string | null; severity: string | null; sizeBytes: number | null }[]) : [],
      },
    };
  }

  /**
   * The evidence-and-age summary of one computer (0.30): what the Patches tab
   * leads with, and — redacted — what a linked ticket is told. No access check:
   * callers check scope (endpointPatches) or are rem0te itself (alert events).
   */
  summaryFor(endpointId: string, now = new Date()): Promise<PatchSummary> {
    return patchSummaryFor(this.prisma, endpointId, now);
  }

  // ── Building a deployment ─────────────────────────────────────────────────

  /** The computers of a business this person could put in a deployment, and the updates they are offered. */
  async candidates(actor: ActorContext, businessId: string) {
    if (!Id.safeParse(businessId).success) this.bad('INVALID_REQUEST', 'businessId is required');
    const eps = await this.prisma.endpoint.findMany({
      where: { AND: [this.acl.endpointVisibilityWhere(actor, businessId), { customerId: businessId, status: { not: 'ARCHIVED' } }] },
      select: { id: true, name: true, hostname: true, deviceClass: true, isOnline: true, customerId: true, accessMode: true, updateChannel: true, agentActions: true, agentSha256: true },
      orderBy: { name: 'asc' }, take: 500,
    });
    const postures = await this.postures(eps.map((e) => e.id));
    const updates = new Map<string, DeploymentUpdate & { offeredOn: number; installable: boolean; notInstallableBecause: string | null }>();
    const computers = [];
    for (const e of eps) {
      const full = await this.actions.endpointFor(e.id);
      const notReady = full ? this.actions.readiness(full, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`) : 'not found';
      const p = postures.get(e.id) ?? null;
      computers.push({
        id: e.id, hostname: e.hostname ?? e.name, deviceClass: e.deviceClass, isOnline: e.isOnline,
        notReady, scannedAt: p?.scannedAt ?? null, managers: (p?.managers ?? []).map((m) => MANAGER_LABEL[m]), rebootPending: p?.reboot.pending ?? null,
        offered: p?.updates.length ?? null,
      });
      for (const u of p?.updates ?? []) {
        const k = idKey(u);
        const e2 = eligibility(u);
        const cur = updates.get(k);
        if (cur) cur.offeredOn++;
        else updates.set(k, { updateId: u.updateId, revision: u.revision, kb: u.kb ?? null, title: u.title, className: u.className ?? null, severity: u.severity || null, offeredOn: 1, installable: e2.ok, notInstallableBecause: e2.reason });
      }
    }
    return { computers, updates: [...updates.values()].sort((a, b) => Number(b.installable) - Number(a.installable) || b.offeredOn - a.offeredOn) };
  }

  async create(actor: ActorContext, raw: unknown) {
    const parsed = CreateDeploymentDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const d = await this.build(actor, parsed.data, 'DEPLOYMENT', null);
    return this.detail(actor, d.id);
  }

  /**
   * Check and store a deployment. Every computer is checked as for any
   * deployment — scope, live access to high-impact requests, readiness, a
   * signed scan, not managed elsewhere — whoever or whatever asks.
   */
  async build(actor: ActorContext, dto: z.infer<typeof CreateDeploymentDto>, origin: 'DEPLOYMENT' | 'MANUAL' | 'POLICY', policy: PolicyOrigin | null): Promise<PatchDeployment> {
    const all = dto.rings.flat();
    if (new Set(all).size !== all.length) this.bad('BAD_RINGS', 'A computer can be in one ring only.');
    if (dto.rings[0].length !== 1) this.bad('BAD_RINGS', 'Ring 0 is the canary: exactly one computer.');
    if (new Set(dto.updates.map(idKey)).size !== dto.updates.length) this.bad('INVALID_REQUEST', 'An update is listed twice.');

    // A policy's deployment holds every computer the policy names, so ring
    // positions match the signed policy. Its canary is checked now; a later
    // ring's computers are checked when that ring is requested, and any not
    // ready then are left out of its plan with the reason (requestRing's
    // exclude). Scope and business are checked for all of them, always.
    const checkNow = (id: string) => origin !== 'POLICY' || id === dto.rings[0][0];
    for (const id of all) {
      await this.acl.assertEndpointInScope(actor, id);
      const ep = await this.actions.endpointFor(id);
      if (!ep || ep.customerId !== dto.businessId || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
      if (!checkNow(id)) continue;
      const name = ep.hostname ?? ep.name;
      const d = await this.policy.evaluateAction(actor, ep, 'high');
      if (!d.ok) throw new ForbiddenException({ code: d.reason.toUpperCase(), message: `${name}: ${d.message}`, endpointId: id });
      const notReady = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
      if (notReady) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: ${notReady}`, endpointId: id });
    }
    const postures = await this.postures(all);
    for (const id of all.filter(checkNow)) {
      const p = postures.get(id);
      const ep = (await this.actions.endpointFor(id))!;
      if (!p) throw new ConflictException({ code: 'NO_PATCH_POSTURE', message: `${ep.hostname ?? ep.name} has not reported a patch scan yet. Refresh its inventory and wait for the scan.`, endpointId: id });
      if (p.managers.length) throw new ConflictException({ code: 'MANAGED_ELSEWHERE', message: `${ep.hostname ?? ep.name}'s updates are managed by ${p.managers.map((m) => MANAGER_LABEL[m]).join(', ')}; its agent would refuse the plan. Leave it out, or patch it there.`, endpointId: id });
    }
    // Every update must be one that some computer in the deployment is
    // offered and may install: that is also where its title and KB come from.
    const updates: DeploymentUpdate[] = [];
    for (const want of dto.updates) {
      let found: DeploymentUpdate | null = null;
      for (const [eid, p] of postures) {
        if (!checkNow(eid)) continue;
        const u = p.updates.find((x) => idKey(x) === idKey(want));
        if (!u) continue;
        const e = eligibility(u);
        if (!e.ok) this.bad('UPDATE_NOT_INSTALLABLE', `${u.kb ?? u.title}: ${e.reason}.`);
        // The class name shown (and judged by a patch policy) is the one the
        // classification id means, never the device's own label for it.
        found = { updateId: u.updateId, revision: u.revision, kb: u.kb ?? null, title: u.title, className: CLASSIFICATIONS[u.classification] ?? u.className ?? null, severity: u.severity || null };
        break;
      }
      if (!found) this.bad('UPDATE_NOT_OFFERED', `No computer in this deployment is offered ${want.updateId} (revision ${want.revision}). Pick updates from a recent scan.`);
      updates.push(found);
    }
    const first = (await this.actions.endpointFor(all[0]))!;
    const d = await this.prisma.patchDeployment.create({
      data: {
        tenantId: first.tenantId, customerId: dto.businessId, name: dto.name, updates: updates as unknown as Prisma.InputJsonValue,
        rings: dto.rings.map((r) => ({ endpointIds: r })) as unknown as Prisma.InputJsonValue,
        soakHours: dto.soakHours, failureThreshold: dto.failureThreshold, windowHours: dto.windowHours, createdById: actor.userId,
        origin, policyId: policy?.policyId ?? null, windowKey: policy?.windowKey ?? null,
      },
    });
    await this.audit.log({ tenantId: first.tenantId ?? undefined, customerId: dto.businessId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_DEPLOYMENT_CREATED', resource: 'patch_deployment', resourceId: d.id, meta: { name: dto.name, origin, policyId: policy?.policyId ?? null, windowKey: policy?.windowKey ?? null, updates: updates.map((u) => u.kb ?? u.updateId), rings: dto.rings.map((r) => r.length), soakHours: dto.soakHours, failureThreshold: dto.failureThreshold } });
    return d;
  }

  // ── Installing from one computer's Patches tab (0.32) ────────────────────

  /**
   * Can this person install updates on this computer from its Patches tab,
   * and if not, exactly why and what to do. The button is offered only when
   * `possible`; the same checks run again when the request arrives, and once
   * more inside build().
   */
  async installState(actor: ActorContext, endpointId: string): Promise<{ possible: boolean; reason: string | null; fix: string | null; installable: number }> {
    const no = (reason: string, fix: string | null) => ({ possible: false, reason, fix, installable: 0 });
    const ep = await this.actions.endpointFor(endpointId);
    if (!ep || !ep.customerId) return no('This computer is not in a business.', null);
    const full = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { isOnline: true, updateChannel: true } });
    if (full?.updateChannel !== 'signed') {
      return no('This computer runs the standard agent, which only reports updates. Installing needs the signed agent, which runs only plans approved on the roster.',
        'Switch this computer to the signed channel: publish a signed release, then migrate it (Patching setup, step 2).');
    }
    const notReady = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
    if (notReady) {
      return no(notReady, /no signed agent build is published/i.test(notReady) ? 'Publish a signed release (Patching setup, step 1).'
        : /legacy agent/i.test(notReady) ? 'Switch this computer to the signed channel (Patching setup, step 2).'
          : /no enrolled device identity/i.test(notReady) ? 'Re-enrol the computer so it has a device identity.'
            : 'Let it update to the published signed build: it updates itself at its next check-in.');
    }
    const posture = (await this.postures([endpointId])).get(endpointId) ?? null;
    if (!posture) return no('The signed agent has not reported a Windows Update scan yet.', 'Press Scan now and wait for the computer to report.');
    if (posture.managers.length) {
      return no(`Updates on this computer are managed by ${posture.managers.map((m) => MANAGER_LABEL[m]).join(', ')}, and its agent would refuse the plan.`, 'Patch it there, or remove that policy from the computer and scan again.');
    }
    if (!full.isOnline) return no('The computer is offline. A plan is only delivered while it checks in, and its approval window would likely pass first.', 'Wait until it is online.');
    if (!this.signer.configured()) return no('The approval signer is not set up on this server, so nothing can be approved.', 'Install the approval signer and set APPROVAL_SIGNER_INTERNAL_URL (Patching setup, steps 3–5).');
    const d = await this.policy.evaluateAction(actor, ep, 'high');
    if (!d.ok) return no(d.message, d.reason === 'action_not_granted' ? 'Ask someone whose access includes higher-risk requests.' : null);
    const blocking = await this.actions.blocking(endpointId, UPDATE_INSTALL.id);
    if (blocking) return no(blocking.status === 'UNKNOWN' ? 'An earlier install on this computer has an uncertain outcome.' : `An install on this computer has already been requested and has not finished (${blocking.status.toLowerCase().replace(/_/g, ' ')}).`, blocking.status === 'UNKNOWN' ? 'Reconcile it on its deployment page first.' : 'Wait for it to finish, or cancel it.');
    const installable = posture.updates.filter((u) => eligibility(u).ok).length;
    if (!installable) return no('Windows Update offers this computer nothing a plan may install.', null);
    return { possible: true, reason: null, fix: null, installable };
  }

  /** "Install updates": one computer, one ring, the usual two approvals. Returns the deployment and its plan. */
  async installOnEndpoint(actor: ActorContext, endpointId: string, raw: unknown) {
    const parsed = InstallDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data;
    await this.acl.assertEndpointInScope(actor, endpointId);
    const st = await this.installState(actor, endpointId);
    if (!st.possible) throw new ConflictException({ code: 'INSTALL_NOT_POSSIBLE', message: st.reason, fix: st.fix });
    const ep = (await this.actions.endpointFor(endpointId))!;
    const host = (ep.hostname ?? ep.name).slice(0, 64);
    const d = await this.build(actor, {
      businessId: ep.customerId!, name: `Install on ${host}`.slice(0, 120), updates: dto.updates, rings: [[endpointId]],
      soakHours: 0, failureThreshold: 0, windowHours: dto.windowHours,
    }, 'MANUAL', null);
    const out = await this.requestRing(actor, d.id, 0, { reason: dto.reason, startsInMinutes: dto.startsInMinutes });
    await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_INSTALL_REQUESTED', resource: 'endpoint', resourceId: endpointId, meta: { deploymentId: d.id, jobId: out.job.id, updates: dto.updates.length, reboot: dto.reboot } });
    return out;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private async scoped(actor: ActorContext, id: string): Promise<PatchDeployment> {
    const d = Id.safeParse(id).success ? await this.prisma.patchDeployment.findUnique({ where: { id } }) : null;
    if (!d) throw new NotFoundException('Deployment not found');
    // Every computer in it must be visible: a deployment is not readable
    // through access to one of its computers.
    for (const r of d.rings as unknown as Ring[]) for (const e of r.endpointIds) await this.acl.assertEndpointInScope(actor, e).catch(() => { throw new NotFoundException('Deployment not found'); });
    return d;
  }

  async list(actor: ActorContext, businessId: string) {
    if (!Id.safeParse(businessId).success) this.bad('INVALID_REQUEST', 'businessId is required');
    const rows = await this.prisma.patchDeployment.findMany({ where: { customerId: businessId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const out = [];
    for (const d of rows) {
      try { await this.scoped(actor, d.id); } catch { continue; }
      const rings = d.rings as unknown as Ring[];
      const jobs = await this.prisma.actionJob.findMany({ where: { deploymentId: d.id }, select: { ring: true, status: true }, orderBy: { createdAt: 'desc' } });
      out.push({ id: d.id, name: d.name, origin: d.origin, policyId: d.policyId, status: d.status, pausedReason: d.pausedReason, rings: rings.map((r) => r.endpointIds.length), updates: (d.updates as unknown as DeploymentUpdate[]).length, lastRing: jobs[0]?.ring ?? null, lastRingStatus: jobs[0]?.status ?? null, createdAt: d.createdAt });
    }
    return out;
  }

  private async ringJobs(d: PatchDeployment): Promise<Map<number, Job>> {
    const rows = await this.prisma.actionJob.findMany({ where: { deploymentId: d.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const out = new Map<number, Job>();
    for (const r of rows) {
      const j = await this.actions.load(r.id);
      out.set(j.ring!, j); // the latest plan for each ring wins
    }
    return out;
  }

  private gateTarget(t: ActionTarget, posture: Posture | null): GateTarget {
    return {
      endpointId: t.endpointId, status: t.status, statusReason: t.statusReason, reconciled: !!t.reconciledAt, reconcileNote: t.reconcileNote,
      resultAt: t.resultAt, result: t.result as GateTarget['result'], scan: posture,
    };
  }

  private computerStates(d: PatchDeployment, j: Job | undefined, endpointId: string, posture: Posture | null) {
    const t = j?.targets.find((x) => x.endpointId === endpointId) ?? null;
    return targetStates(d.updates as unknown as DeploymentUpdate[], t ? this.gateTarget(t, posture) : null, j?.status ?? '');
  }

  /**
   * May the ring after `ring` be requested? The rule is shared with the
   * approval signer (actions/patch-policy.ts evaluateRingGate), which runs it
   * again over the evidence before signing a later ring under a policy.
   */
  gate(d: PatchDeployment, ring: number, j: Job | undefined, postures: Map<string, Posture>, now = new Date()): Gate {
    return evaluateRingGate({
      ring, jobStatus: j?.status ?? null, targets: (j?.targets ?? []).map((t) => this.gateTarget(t, postures.get(t.endpointId) ?? null)),
      updates: d.updates as unknown as DeploymentUpdate[], failureThreshold: d.failureThreshold, soakHours: d.soakHours,
    }, now);
  }

  /** What the signer is told about ring `ring` before it signs the next one under a policy. */
  async ringEvidence(d: PatchDeployment, ring: number): Promise<RingEvidence | null> {
    const j = (await this.ringJobs(d)).get(ring);
    if (!j) return null;
    const postures = await this.postures(j.targets.map((t) => t.endpointId));
    const updates = d.updates as unknown as DeploymentUpdate[];
    return { previousJobId: j.id, jobStatus: j.status, targets: j.targets.map((t) => toEvidenceTarget(this.gateTarget(t, postures.get(t.endpointId) ?? null), updates)) };
  }

  async detail(actor: ActorContext, id: string, now = new Date()) {
    let d = await this.scoped(actor, id);
    const rings = d.rings as unknown as Ring[];
    const jobs = await this.ringJobs(d);
    const all = rings.flatMap((r) => r.endpointIds);
    const postures = await this.postures(all);
    const names = new Map((await this.prisma.endpoint.findMany({ where: { id: { in: all } }, select: { id: true, name: true, hostname: true } })).map((e) => [e.id, e.hostname ?? e.name]));

    const gates = rings.map((_, i) => this.gate(d, i, jobs.get(i), postures, now));
    // Lazily applied: too many failures pause it; the last ring passing completes it.
    if (d.status === 'ACTIVE') {
      const tripped = gates.findIndex((g, i) => g.reason === 'too_many_failures' && jobs.get(i)?.id !== d.resumedOverJobId);
      if (tripped >= 0) {
        d = await this.prisma.patchDeployment.update({ where: { id }, data: { status: 'PAUSED', pausedReason: gates[tripped].detail } });
        await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: id, meta: { status: 'PAUSED', reason: gates[tripped].detail } });
      } else if (gates[rings.length - 1].ok || gates[rings.length - 1].reason === 'soaking') {
        // Soak time only holds back the next ring; after the last, nothing waits on it.
        d = await this.prisma.patchDeployment.update({ where: { id }, data: { status: 'COMPLETED' } });
        await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: id, meta: { status: 'COMPLETED' } });
      }
    }
    const next = this.nextRing(d, jobs, gates);
    return {
      id: d.id, name: d.name, businessId: d.customerId, origin: d.origin, policyId: d.policyId, windowKey: d.windowKey, status: d.status, pausedReason: d.pausedReason,
      soakHours: d.soakHours, failureThreshold: d.failureThreshold, windowHours: d.windowHours, createdById: d.createdById, createdAt: d.createdAt,
      updates: d.updates,
      next,
      rings: rings.map((r, i) => {
        const j = jobs.get(i);
        return {
          ring: i, canary: i === 0, gate: gates[i],
          job: j ? { id: j.id, status: j.status, statusReason: j.statusReason, approvalUrl: j.approvalUrl, outcome: j.outcome, window: { notBefore: j.notBefore, notAfter: j.notAfter }, digest: j.digest } : null,
          computers: r.endpointIds.map((e) => {
            const t = j?.targets.find((x) => x.endpointId === e);
            const p = postures.get(e) ?? null;
            return {
              endpointId: e, hostname: names.get(e) ?? null, inPlan: !!t, status: t?.status ?? null, statusReason: t?.statusReason ?? null, outcome: t?.outcome ?? null,
              reconciled: t?.reconciledAt ? t.reconcileNote : null,
              rebootPending: p?.reboot.pending ?? null, scannedAt: p?.scannedAt ?? null,
              updates: this.computerStates(d, j, e, p),
            };
          }),
        };
      }),
    };
  }

  private nextRing(d: PatchDeployment, jobs: Map<number, Job>, gates: Gate[]): { ring: number | null; canRequest: boolean; why: string } {
    const n = (d.rings as unknown as Ring[]).length;
    if (d.status !== 'ACTIVE') return { ring: null, canRequest: false, why: `The deployment is ${d.status.toLowerCase()}${d.pausedReason ? `: ${d.pausedReason}` : ''}.` };
    for (let i = 0; i < n; i++) {
      const j = jobs.get(i);
      if (!j || ['REJECTED', 'CANCELED', 'EXPIRED'].includes(j.status)) {
        if (i === 0) return { ring: 0, canRequest: true, why: j ? 'The canary\'s plan did not run; request it again.' : 'Start with the canary.' };
        const g = gates[i - 1];
        return { ring: i, canRequest: g.ok, why: g.ok ? `Ring ${i - 1} passed.` : g.detail };
      }
      const g = gates[i];
      if (g.ok) continue;
      // A ring over its failure threshold is retried as a new plan, with a new
      // approval — never promoted past.
      if (g.reason === 'too_many_failures') return { ring: i, canRequest: true, why: `${g.detail} Request ring ${i} again to retry, leaving out computers if you need to.` };
      if (g.reason === 'soaking' && i === n - 1) break;
      return { ring: i + 1 < n ? i + 1 : null, canRequest: false, why: g.detail };
    }
    return { ring: null, canRequest: false, why: 'Every ring has run.' };
  }

  // ── Acting ────────────────────────────────────────────────────────────────

  /**
   * Request one ring as a signed plan. With `under` (only the patch-policy
   * sweep passes it) the plan goes to the signer under that policy, with its
   * exact window, filter and the previous ring's evidence; the signer signs
   * it at once or refuses it. Otherwise it awaits two approvals.
   */
  async requestRing(actor: ActorContext, id: string, ring: number, raw: unknown, under?: UnderPolicy) {
    const parsed = RequestRingDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data;
    const d = await this.scoped(actor, id);
    if (under && d.policyId !== under.policyId) this.bad('INVALID_REQUEST', 'This deployment was not proposed by that policy.');
    // A policy's rings are signed by the signer under that policy, in order,
    // or not at all. A person cannot request one beside it.
    if (!under && d.origin === 'POLICY') throw new ConflictException({ code: 'POLICY_DEPLOYMENT', message: 'This deployment belongs to a patch policy; its rings are requested by the policy. Pause or cancel it here, or revoke the policy.' });
    const detail = await this.detail(actor, id);
    if (detail.next.ring !== ring || !detail.next.canRequest) {
      throw new ConflictException({ code: 'RING_GATE', message: detail.next.ring === ring ? detail.next.why : `Ring ${ring} cannot be requested now. ${detail.next.why}` });
    }
    const members = (d.rings as unknown as Ring[])[ring].endpointIds;
    const excluded = new Map(dto.exclude.map((x) => [x.endpointId, x.why]));
    for (const e of excluded.keys()) if (!members.includes(e)) this.bad('INVALID_REQUEST', 'Only computers of this ring can be left out.');
    if (ring === 0 && excluded.size) this.bad('INVALID_REQUEST', 'The canary cannot be left out; create a new deployment with another canary.');
    const endpointIds = members.filter((e) => !excluded.has(e));
    if (!endpointIds.length) this.bad('INVALID_REQUEST', 'Every computer of this ring is left out.');
    const updates = d.updates as unknown as DeploymentUpdate[];
    const job = await this.actions.createPlan(actor, {
      action: UPDATE_INSTALL, endpointIds,
      params: { updates: updates.map((u) => ({ updateId: u.updateId, revision: u.revision })), reboot: 'never', ...(under ? { allow: under.allow } : {}) },
      reason: `${d.name} — ${ring === 0 ? 'canary' : `ring ${ring}`}: ${dto.reason}`.slice(0, 500),
      startsInMinutes: dto.startsInMinutes, windowHours: d.windowHours,
      display: {
        updates, deployment: { id: d.id, name: d.name.slice(0, 120), ring, rings: (d.rings as unknown as Ring[]).length },
        ...(under ? { policy: { id: under.policyId, name: under.name.slice(0, 120), digest: under.digest } } : {}),
      },
      deployment: { id: d.id, ring },
      ...(under ? { window: under.window, underPolicy: { policyId: under.policyId, digest: under.digest, evidence: ring === 0 ? null : await this.ringEvidence(d, ring - 1) } } : {}),
    });
    await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_RING_REQUESTED', resource: 'patch_deployment', resourceId: d.id, meta: { ring, jobId: job.id, computers: endpointIds.length, excluded: Object.fromEntries(excluded), underPolicy: under?.policyId ?? null } });
    return { job: await this.actions.view(job), deployment: await this.detail(actor, id) };
  }

  private mayManage(actor: ActorContext, d: PatchDeployment) {
    return actor.isPlatformAdmin || d.createdById === actor.userId || (!actor.technician && actor.businessId === d.customerId && this.acl.isBusinessOwner(actor));
  }

  async setStatus(actor: ActorContext, id: string, to: 'pause' | 'resume' | 'cancel', raw: unknown) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'A reason of at least 3 characters is required.');
    const d = await this.scoped(actor, id);
    if (!this.mayManage(actor, d)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the deployment, a Business Owner of this business or a Platform Admin can change it.' });
    const from = { pause: ['ACTIVE'], resume: ['PAUSED'], cancel: ['ACTIVE', 'PAUSED'] }[to];
    if (!from.includes(d.status)) throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: `The deployment is ${d.status.toLowerCase()}.` });
    let resumedOverJobId = d.resumedOverJobId;
    if (to === 'resume') {
      // Resuming acknowledges the ring plan that tripped the threshold. It
      // does not promote past it: that ring can only be retried.
      const latest = await this.prisma.actionJob.findFirst({ where: { deploymentId: id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      resumedOverJobId = latest?.id ?? null;
    }
    if (to === 'cancel') {
      // Stop what has not reached a computer yet. Anything delivered runs to
      // its own result; the agent's journal decides, not this.
      for (const j of await this.prisma.actionJob.findMany({ where: { deploymentId: id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, select: { id: true } })) {
        await this.actions.cancel(actor, j.id).catch(() => undefined);
      }
    }
    const status = { pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELED' }[to] as PatchDeployment['status'];
    await this.prisma.patchDeployment.update({ where: { id }, data: { status, resumedOverJobId, pausedReason: to === 'pause' ? dto.data!.reason : to === 'resume' ? null : d.pausedReason } });
    await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: id, meta: { status, reason: dto.data!.reason } });
    return this.detail(actor, id);
  }
}
