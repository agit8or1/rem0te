import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ActionJob, type ActionTarget, type PatchDeployment } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ActionsService } from '../actions/actions.service';
import { MAX_RING_TARGETS, MAX_UPDATES_PER_PLAN, UPDATE_ID_RE, UPDATE_INSTALL } from '../actions/catalog';
import { MANAGER_LABEL, Posture, eligibility, idKey, updateState, type UpdateState } from './posture';
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

type DeploymentUpdate = { updateId: string; revision: number; kb: string | null; title: string; className: string | null; severity: string | null };
type Ring = { endpointIds: string[] };
type Job = ActionJob & { targets: ActionTarget[] };

/** A computer counts as failed in a ring if Windows (or the agent) said no to anything, or nobody knows. */
const FAILED_STATES: UpdateState[] = ['failed', 'unknown', 'refused', 'not_executed'];
/** The canary's proof: each update took effect, or genuinely did not apply to it. */
const CANARY_OK: UpdateState[] = ['effective', 'superseded', 'not_applicable', 'excluded'];

export interface Gate { ok: boolean; reason: string; detail: string; until?: string }

@Injectable()
export class PatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly policy: AccessPolicyService,
    private readonly actions: ActionsService,
  ) {}

  private bad(code: string, message: string, extra: Record<string, unknown> = {}): never {
    throw new BadRequestException({ code, message, ...extra });
  }

  private async postures(endpointIds: string[]): Promise<Map<string, Posture>> {
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
    const dto = parsed.data;
    const all = dto.rings.flat();
    if (new Set(all).size !== all.length) this.bad('BAD_RINGS', 'A computer can be in one ring only.');
    if (dto.rings[0].length !== 1) this.bad('BAD_RINGS', 'Ring 0 is the canary: exactly one computer.');
    if (new Set(dto.updates.map(idKey)).size !== dto.updates.length) this.bad('INVALID_REQUEST', 'An update is listed twice.');

    for (const id of all) {
      await this.acl.assertEndpointInScope(actor, id);
      const ep = await this.actions.endpointFor(id);
      if (!ep || ep.customerId !== dto.businessId || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
      const name = ep.hostname ?? ep.name;
      const d = await this.policy.evaluateAction(actor, ep, 'high');
      if (!d.ok) throw new ForbiddenException({ code: d.reason.toUpperCase(), message: `${name}: ${d.message}`, endpointId: id });
      const notReady = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
      if (notReady) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: ${notReady}`, endpointId: id });
    }
    const postures = await this.postures(all);
    for (const id of all) {
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
      for (const p of postures.values()) {
        const u = p.updates.find((x) => idKey(x) === idKey(want));
        if (!u) continue;
        const e = eligibility(u);
        if (!e.ok) this.bad('UPDATE_NOT_INSTALLABLE', `${u.kb ?? u.title}: ${e.reason}.`);
        found = { updateId: u.updateId, revision: u.revision, kb: u.kb ?? null, title: u.title, className: u.className ?? null, severity: u.severity || null };
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
      },
    });
    await this.audit.log({ tenantId: first.tenantId ?? undefined, customerId: dto.businessId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_DEPLOYMENT_CREATED', resource: 'patch_deployment', resourceId: d.id, meta: { name: dto.name, updates: updates.map((u) => u.kb ?? u.updateId), rings: dto.rings.map((r) => r.length), soakHours: dto.soakHours, failureThreshold: dto.failureThreshold } });
    return this.detail(actor, d.id);
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
      out.push({ id: d.id, name: d.name, status: d.status, pausedReason: d.pausedReason, rings: rings.map((r) => r.endpointIds.length), updates: (d.updates as unknown as DeploymentUpdate[]).length, lastRing: jobs[0]?.ring ?? null, lastRingStatus: jobs[0]?.status ?? null, createdAt: d.createdAt });
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

  private computerStates(d: PatchDeployment, j: Job | undefined, endpointId: string, posture: Posture | null) {
    const t = j?.targets.find((x) => x.endpointId === endpointId) ?? null;
    const tv = t ? { status: t.status, statusReason: t.statusReason, jobStatus: j!.status, result: t.result as never, resultAt: t.resultAt, reconciledNote: t.reconcileNote } : null;
    return (d.updates as unknown as DeploymentUpdate[]).map((u) => ({ key: idKey(u), ...updateState(u, tv, posture) }));
  }

  /** May the ring after `ring` be requested? */
  gate(d: PatchDeployment, ring: number, j: Job | undefined, postures: Map<string, Posture>, now = new Date()): Gate {
    if (!j) return { ok: false, reason: 'not_requested', detail: `Ring ${ring} has not been requested.` };
    if (['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(j.status)) return { ok: false, reason: 'in_progress', detail: `Ring ${ring} is ${j.status.toLowerCase().replace(/_/g, ' ')}.` };
    if (['REJECTED', 'CANCELED', 'EXPIRED'].includes(j.status)) return { ok: false, reason: 'ring_not_run', detail: `Ring ${ring}'s plan was ${j.status.toLowerCase()}; request it again.` };
    if (j.targets.some((t) => t.status === 'UNKNOWN' && !t.reconciledAt)) return { ok: false, reason: 'unreconciled', detail: `A computer in ring ${ring} has an uncertain outcome. Reconcile it first.` };
    const computers = j.targets.filter((t) => t.status !== 'CANCELED');
    if (computers.length === 0) return { ok: false, reason: 'ring_not_run', detail: `No computer in ring ${ring} was reached.` };
    const failed = computers.filter((t) => t.status !== 'SUCCEEDED' || this.computerStates(d, j, t.endpointId, postures.get(t.endpointId) ?? null).some((s) => FAILED_STATES.includes(s.state)));
    if (failed.length > d.failureThreshold) return { ok: false, reason: 'too_many_failures', detail: `${failed.length} computer(s) in ring ${ring} failed; the threshold is ${d.failureThreshold}.` };
    if (ring === 0) {
      const states = this.computerStates(d, j, computers[0].endpointId, postures.get(computers[0].endpointId) ?? null);
      const pending = states.filter((s) => !CANARY_OK.includes(s.state));
      if (pending.length) return { ok: false, reason: 'canary_not_effective', detail: `The canary has not confirmed ${pending.length} update(s) took effect (${[...new Set(pending.map((s) => s.state.replace(/_/g, ' ')))].join(', ')}). Restart it if it needs one, and let it scan again.` };
      if (!states.some((s) => s.state === 'effective')) return { ok: false, reason: 'canary_proved_nothing', detail: 'None of these updates applied to the canary, so it proves nothing. Choose a canary that is offered them.' };
    }
    const last = computers.map((t) => t.resultAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const until = last + d.soakHours * 3_600_000;
    if (now.getTime() < until) return { ok: false, reason: 'soaking', detail: `Soaking until ${new Date(until).toISOString()}.`, until: new Date(until).toISOString() };
    return { ok: true, reason: 'passed', detail: `Ring ${ring} passed.` };
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
      id: d.id, name: d.name, businessId: d.customerId, status: d.status, pausedReason: d.pausedReason,
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

  async requestRing(actor: ActorContext, id: string, ring: number, raw: unknown) {
    const parsed = RequestRingDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data;
    const d = await this.scoped(actor, id);
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
      params: { updates: updates.map((u) => ({ updateId: u.updateId, revision: u.revision })), reboot: 'never' },
      reason: `${d.name} — ${ring === 0 ? 'canary' : `ring ${ring}`}: ${dto.reason}`.slice(0, 500),
      startsInMinutes: dto.startsInMinutes, windowHours: d.windowHours,
      display: { updates, deployment: { id: d.id, name: d.name.slice(0, 120), ring, rings: (d.rings as unknown as Ring[]).length } },
      deployment: { id: d.id, ring },
    });
    await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_RING_REQUESTED', resource: 'patch_deployment', resourceId: d.id, meta: { ring, jobId: job.id, computers: endpointIds.length, excluded: Object.fromEntries(excluded) } });
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
