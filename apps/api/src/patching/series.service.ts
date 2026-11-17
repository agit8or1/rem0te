import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, type PatchPolicy, type PatchPolicySeries } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ActionsService } from '../actions/actions.service';
import { CAP } from '../rbac/capabilities';
import { assertFresh } from '../security-controls/review';
import { UPDATE_INSTALL } from '../actions/catalog';
import { PolicyDoc, PolicyWindow, nextOccurrence, scheduleInWords } from '../actions/patch-policy';
import { selfSignedScanKey } from '../actions/device-result';
import { PatchingService } from './patching.service';
import { PatchPolicyService } from './policies.service';
import {
  CreateSeriesDto, OverrideDto, SeriesSettings, maxPolicyComputers, membershipFingerprint, planAllAtOnce, planRings, revisionDecision, revisionMinutes, revisionReason, seriesStaging, settleMinutes,
  type Candidate, type LeftOut, type RevisionDecision, type SeriesScope,
} from './assignment';

/**
 * Company-wide and assignable patch policies (0.50), and each computer's
 * Patch policy setting.
 *
 * A series ("business": every computer whose setting is Inherit; "assigned":
 * the computers set to use it) never signs or widens anything itself. It
 * works out the closed list of computers its next document would name and,
 * when that differs from the running revision or the running revision is
 * about to expire, proposes a new revision through PatchPolicyService.admit —
 * the same path, and the same per-computer checks, as a policy made by hand.
 * The approval signer then holds that document exactly as it holds any other.
 *
 * Bounded (revisionDecision): never while the running revision has a
 * deployment in progress, a change of computers only after it has held for
 * PATCH_POLICY_SETTLE_MINUTES, and at most one automatic revision pass per
 * business per PATCH_POLICY_REVISION_MINUTES (a conditional claim row).
 *
 * A computer is in one policy at a time: its live PatchPolicyComputer row,
 * unique per computer in the database. A revision goes live (promote) only
 * once it is ACTIVE on the signer and the running one has no deployment in
 * progress; in signed mode the running revision keeps running until then.
 *
 * Runs inside the patch-policy sweep (PATCH_POLICY_SWEEP), never on its own.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const ReasonDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

interface Check {
  at: string; code: string; message: string; until?: string | null;
  members: number; rings: number[]; canary: { endpointId: string; hostname: string; why: string } | null;
  leftOut: LeftOut[]; lastRingOnly: string[];
  promotion?: { code: string; message: string } | null;
}

interface Desired {
  ok: boolean; code: string; message: string;
  rings: string[][]; fingerprint: string | null;
  canary: Check['canary']; leftOut: LeftOut[]; lastRingOnly: string[];
  identity: Map<string, { hostname: string }>;
}

@Injectable()
export class PatchSeriesService implements OnModuleInit {
  private readonly logger = new Logger('PatchSeries');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly access: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly patching: PatchingService,
    private readonly policies: PatchPolicyService,
  ) {}

  onModuleInit() {
    this.policies.attachSeries({ tick: (now) => this.tick(now), onRevoked: (r, by, actorId) => this.onRevoked(r, by, actorId) });
  }

  private bad(code: string, message: string): never { throw new BadRequestException({ code, message }); }

  private mayManage(actor: ActorContext, businessId: string) {
    return actor.isPlatformAdmin || (!actor.technician && actor.businessId === businessId && this.acl.isBusinessOwner(actor));
  }

  // ── Who would be in it ────────────────────────────────────────────────────

  /**
   * The computers this series covers, each checked as the series' author
   * would be checked at admission, and the rings the next revision would
   * have. Read-only.
   */
  private async desired(s: PatchPolicySeries, actor: ActorContext, previousCanary: string | null, now: Date): Promise<Desired> {
    const settings = SeriesSettings.parse(s.settings);
    const eps = await this.prisma.endpoint.findMany({
      where: { customerId: s.customerId, status: { not: 'ARCHIVED' }, ...(s.scope === 'business' ? { patchPolicyMode: 'inherit' } : { patchPolicyMode: 'policy', patchPolicySeriesId: s.id }) },
      select: { id: true, name: true, hostname: true, platform: true, updateChannel: true, createdAt: true },
      orderBy: { createdAt: 'asc' }, take: 1000,
    });
    const identity = new Map<string, { hostname: string }>();
    const leftOut: LeftOut[] = [];
    const cands: Candidate[] = [];
    const postures = await this.patching.postures(eps.map((e) => e.id));
    const hours = await this.prisma.endpointMetricHourly.groupBy({ by: ['endpointId'], where: { endpointId: { in: eps.map((e) => e.id) }, hour: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, _count: { _all: true } });
    const reliability = new Map(hours.map((h) => [h.endpointId, h._count._all]));
    const key = `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`;
    for (const e of eps) {
      const hostname = (e.hostname ?? e.name).slice(0, 64);
      identity.set(e.id, { hostname });
      const out = (code: LeftOut['code'], message: string) => leftOut.push({ endpointId: e.id, hostname, code, message });
      if (!/windows/i.test(e.platform ?? '')) { out('not_windows', `not Windows (it reports ${e.platform ? `"${e.platform.slice(0, 40)}"` : 'no platform'}); patch policies install Windows updates only.`); continue; }
      if (e.updateChannel !== 'signed') { out('no_signed_agent', 'runs the standard agent, which only reports updates. Move it to the signed agent (Devices → Full agent).'); continue; }
      const ep = await this.actions.endpointFor(e.id);
      if (!ep?.rustdeskNode?.rustdeskId || !ep.rustdeskNode.agentSecretHash) { out('no_identity', 'has no enrolled device identity.'); continue; }
      const held = await this.policies.heldElsewhere(e.id, s.id);
      if (held) { out('in_other_policy', held); continue; }
      const dec = await this.access.evaluateAction(actor, ep, 'high');
      if (!dec.ok) { out('not_allowed', dec.message); continue; }
      const p = postures.get(e.id) ?? null;
      const resultKey = p?.signed ? selfSignedScanKey(p.signed, { rustdeskId: ep.rustdeskNode.rustdeskId, deviceSecretSha256: ep.rustdeskNode.agentSecretHash }) : null;
      cands.push({
        endpointId: e.id, hostname, createdAt: e.createdAt.getTime(), rustdeskId: ep.rustdeskNode.rustdeskId, deviceSecretSha256: ep.rustdeskNode.agentSecretHash,
        resultKey, canaryReady: !this.actions.readiness(ep, key), reliability: reliability.get(e.id) ?? 0,
      });
    }
    // 0.62: all at once has no canary to choose and no result key to need.
    const plan = seriesStaging(settings) === 'none'
      ? (() => { const p = planAllAtOnce(cands); return p.ok ? { ...p, canary: null, lastRingOnly: [] as string[] } : p; })()
      : planRings(cands, { preferredCanary: settings.canaryEndpointId ?? null, previousCanary });
    if (!plan.ok) return { ok: false, code: plan.code, message: plan.message, rings: [], fingerprint: null, canary: null, leftOut: [...leftOut, ...plan.leftOut], lastRingOnly: [], identity };
    const byId = new Map(cands.map((c) => [c.endpointId, c]));
    const fingerprint = membershipFingerprint(plan.rings.map((r) => r.map((id) => { const c = byId.get(id)!; return { endpointId: id, rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256, resultKey: c.resultKey ?? undefined }; })));
    return {
      ok: true, code: 'ok', message: `${plan.rings.flat().length} computer(s) in ${plan.rings.length} ring(s).`,
      rings: plan.rings, fingerprint, canary: plan.canary, leftOut: [...leftOut, ...plan.leftOut],
      lastRingOnly: plan.lastRingOnly.map((id) => byId.get(id)?.hostname ?? id), identity,
    };
  }

  private static fingerprintOf(r: PatchPolicy): string {
    return membershipFingerprint((r.document as unknown as PolicyDoc).rings);
  }

  /** The revisions that matter now: running, waiting to run, and the newest rejected. */
  private async revisions(s: PatchPolicySeries) {
    const rows = await this.prisma.patchPolicy.findMany({ where: { seriesId: s.id }, orderBy: { revision: 'desc' }, take: 20 });
    const current = rows.find((r) => r.id === s.currentPolicyId) ?? null;
    const after = (r: PatchPolicy) => (r.revision ?? 0) > (current?.revision ?? 0);
    const pending = rows.find((r) => after(r) && r.id !== s.currentPolicyId && (r.status === 'AWAITING_APPROVAL' || r.status === 'ACTIVE')) ?? null;
    const rejected = rows.find((r) => after(r) && r.status === 'REJECTED') ?? null;
    const midRing = current ? !!(await this.prisma.patchDeployment.findFirst({ where: { policyId: current.id, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } })) : false;
    return { rows, current, pending, rejected, midRing };
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  /** One pass: every active series, business by business. Called by the patch-policy sweep only. */
  async tick(now = new Date()) {
    const all = await this.prisma.patchPolicySeries.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' }, take: 200 });
    const byBusiness = new Map<string, PatchPolicySeries[]>();
    for (const s of all) byBusiness.set(s.customerId, [...(byBusiness.get(s.customerId) ?? []), s]);
    for (const [businessId, list] of byBusiness) {
      try { await this.tickBusiness(businessId, list, now); } catch (e) { this.logger.warn(`business ${businessId}: ${(e as Error).message}`); }
    }
  }

  /**
   * The per-business bound: at most one automatic revision pass per
   * revisionMinutes(), taken by one conditional upsert, so two processes
   * cannot both take it.
   */
  private async claim(businessId: string, now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - revisionMinutes() * 60_000);
    const rows = await this.prisma.$queryRaw<{ customerId: string }[]>`
      INSERT INTO "PatchPolicyRevisionClaim" ("customerId", "at") VALUES (${businessId}, ${now})
      ON CONFLICT ("customerId") DO UPDATE SET "at" = EXCLUDED."at" WHERE "PatchPolicyRevisionClaim"."at" <= ${cutoff}
      RETURNING "customerId"`;
    return rows.length === 1;
  }

  private async tickBusiness(businessId: string, list: PatchPolicySeries[], now: Date) {
    const claimRow = await this.prisma.patchPolicyRevisionClaim.findUnique({ where: { customerId: businessId } });
    let claimed: boolean | null = null;
    for (const s0 of list) {
      const s = await this.prisma.patchPolicySeries.findUnique({ where: { id: s0.id } });
      if (!s || s.status !== 'active') continue;
      const settings = SeriesSettings.parse(s.settings);
      const actor = await this.actors.contextFor(s.createdById, s.tenantId ?? '', s.customerId);
      const v = await this.revisions(s);
      if (!actor) {
        await this.record(s, { code: 'author_inactive', message: 'Whoever created this policy is no longer active or no longer reaches this business, so no revision is proposed on their behalf. Retire it and create a new one.' }, null, now);
        continue;
      }
      const previousCanary = (v.current?.document as unknown as PolicyDoc | undefined)?.rings[0][0]?.endpointId ?? null;
      const d = await this.desired(s, actor, previousCanary, now);
      const decision = revisionDecision({
        now, desired: d.ok && d.fingerprint ? { fingerprint: d.fingerprint } : null,
        current: v.current ? { fingerprint: PatchSeriesService.fingerprintOf(v.current), expiresAt: v.current.expiresAt, status: v.current.status } : null,
        pending: v.pending ? { fingerprint: PatchSeriesService.fingerprintOf(v.pending), status: v.pending.status, revision: v.pending.revision ?? 0 } : null,
        rejected: v.rejected ? PatchSeriesService.fingerprintOf(v.rejected) : null,
        settle: { fingerprint: s.settleFingerprint, since: s.settleSince },
        lastClaimAt: claimRow?.at ?? null, midRing: v.midRing, expiresInDays: settings.expiresInDays,
      });
      let outcome: { code: string; message: string; until?: Date | null } = 'code' in decision ? { code: decision.code, message: decision.message, until: 'until' in decision ? decision.until ?? null : null } : { code: decision.act, message: decision.message };
      if (!d.ok && decision.act === 'hold' && decision.code === 'no_computers') outcome = { code: d.code, message: d.message };
      if (decision.act === 'hold' && decision.settle) {
        await this.prisma.patchPolicySeries.update({ where: { id: s.id }, data: { settleFingerprint: decision.settle.fingerprint, settleSince: decision.settle.since } });
      }
      if (decision.act === 'propose') {
        if (claimed === null) claimed = await this.claim(businessId, now);
        if (!claimed) outcome = { code: 'rate_limited', message: `This business had an automatic revision less than ${revisionMinutes()} minute(s) ago.` };
        else outcome = await this.proposeRevision(s, settings, actor, d, decision, v.current, v.pending, now);
      } else if (decision.act === 'withdraw' && v.current) {
        await this.policies.withdraw(v.current, 'no computer is eligible for this policy any more', { seriesId: s.id, revision: v.current.revision }, now);
        await this.prisma.patchPolicySeries.updateMany({ where: { id: s.id, currentPolicyId: v.current.id }, data: { currentPolicyId: null } });
      } else if (decision.act === 'drop_pending' && v.pending) {
        await this.policies.withdraw(v.pending, `revision ${v.pending.revision} no longer matches the computers; withdrawn before it took over`, { seriesId: s.id, revision: v.pending.revision }, now);
      }
      await this.record(s, outcome, d, now);
      await this.promote(s.id, now);
    }
    // Again, once all have moved: a computer moving between two policies of
    // this business is let go by one before the other can take it.
    for (const s of list) await this.promote(s.id, now);
  }

  private async proposeRevision(s: PatchPolicySeries, settings: SeriesSettings, actor: ActorContext, d: Desired, decision: Extract<RevisionDecision, { act: 'propose' }>, current: PatchPolicy | null, pending: PatchPolicy | null, now: Date) {
    const revision = s.lastRevision + 1;
    // The revision number is taken by a conditional write, so it is never used twice.
    const took = await this.prisma.patchPolicySeries.updateMany({ where: { id: s.id, lastRevision: s.lastRevision, status: 'active' }, data: { lastRevision: revision, settleFingerprint: null, settleSince: null } });
    if (took.count !== 1) return { code: 'changed', message: 'The policy changed while the revision was prepared; it is looked at again on the next pass.' };
    const before = new Set((current?.document as unknown as PolicyDoc | undefined)?.rings.flat().map((c) => c.endpointId) ?? []);
    const after = new Set(d.rings.flat());
    const name = (id: string) => d.identity.get(id)?.hostname ?? id;
    const added = [...after].filter((id) => !before.has(id)).map(name);
    const removed = [...before].filter((id) => !after.has(id)).map((id) => (current?.document as unknown as PolicyDoc).rings.flat().find((c) => c.endpointId === id)?.hostname ?? id);
    try {
      const out = await this.policies.admit(actor, {
        businessId: s.customerId, name: s.name, rings: d.rings, staging: seriesStaging(settings), allow: settings.allow, soakHours: settings.soakHours, failureThreshold: settings.failureThreshold,
        window: settings.window, reboot: settings.reboot, expiresInDays: settings.expiresInDays,
        ...(settings.restart ? { restart: settings.restart } : {}), ...(settings.ignoreRemoteSession ? { ignoreRemoteSession: true as const } : {}),
        reason: revisionReason(s.name, s.scope as SeriesScope, revision, decision.trigger, current ? added : [], removed),
      }, now, { seriesId: s.id, revision, supersedesId: current?.id ?? null });
      if (pending) await this.policies.withdraw(pending, `replaced by revision ${revision} before it took over`, { seriesId: s.id, revision: pending.revision, replacedBy: out.id }, now);
      return { code: 'proposed', message: `Revision ${revision} proposed (${decision.trigger}): ${out.status === 'ACTIVE' ? 'active at admission (direct mode)' : 'awaiting approval on the approval signer'}.` };
    } catch (e) {
      await this.prisma.patchPolicySeries.updateMany({ where: { id: s.id, lastRevision: revision }, data: { lastRevision: s.lastRevision } });
      const b = (e as { getResponse?: () => { code?: string; signerCode?: string | null; message?: string } }).getResponse?.();
      return { code: b?.signerCode ?? b?.code ?? 'revision_refused', message: `Revision ${revision} was refused: ${b?.message ?? (e as Error).message}` };
    }
  }

  /**
   * Hand the computers to the newest ACTIVE revision, once the running one
   * has no deployment in progress. One transaction: the running revision's
   * live rows go first, then the new one's — the per-computer unique index
   * refuses the whole step if any computer is still live in another policy —
   * then the series' pointer, conditionally. The replaced revision is then
   * withdrawn (revoked on the signer, audited as superseded).
   */
  async promote(seriesId: string, now = new Date()): Promise<{ code: string; message: string } | null> {
    const s = await this.prisma.patchPolicySeries.findUnique({ where: { id: seriesId } });
    if (!s || s.status !== 'active') return null;
    const v = await this.revisions(s);
    const next = v.rows.find((r) => r.status === 'ACTIVE' && r.id !== s.currentPolicyId && (r.revision ?? 0) > (v.current?.revision ?? 0) && r.expiresAt > now);
    if (!next) return null;
    let result: { code: string; message: string };
    if (v.current && v.current.status === 'ACTIVE' && v.midRing) {
      result = { code: 'waiting_to_take_over', message: `Revision ${next.revision} is active and takes over when revision ${v.current.revision}'s deployment finishes.` };
    } else {
      try {
        await this.prisma.$transaction(async (tx) => {
          if (v.current) await tx.patchPolicyComputer.updateMany({ where: { policyId: v.current.id, live: true }, data: { live: false } });
          await tx.patchPolicyComputer.updateMany({ where: { policyId: next.id }, data: { live: true } });
          const moved = await tx.patchPolicySeries.updateMany({ where: { id: s.id, currentPolicyId: s.currentPolicyId, status: 'active' }, data: { currentPolicyId: next.id } });
          if (moved.count !== 1) throw new ConflictException({ code: 'CHANGED', message: 'The policy changed meanwhile.' });
        });
        await this.audit.log({ tenantId: s.tenantId ?? undefined, customerId: s.customerId, action: 'PATCH_POLICY_UPDATED', resource: 'patch_policy', resourceId: next.id, meta: { seriesId: s.id, revision: next.revision, tookOver: true, from: v.current?.id ?? null } });
        for (const old of v.rows.filter((r) => r.id !== next.id && (r.revision ?? 0) < (next.revision ?? 0) && (r.status === 'ACTIVE' || r.status === 'AWAITING_APPROVAL'))) {
          await this.policies.withdraw(old, `superseded by revision ${next.revision}`, { seriesId: s.id, revision: old.revision, supersededBy: next.id }, now);
        }
        result = { code: 'took_over', message: `Revision ${next.revision} now runs.` };
      } catch (e) {
        const conflict = (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2002' || e.code === 'P2010')) || /PatchPolicyComputer_one_live|unique/i.test((e as Error).message);
        if (!conflict) throw e;
        const held = await this.prisma.patchPolicyComputer.findFirst({ where: { live: true, policyId: { not: v.current?.id ?? '' }, endpoint: { patchPolicyMembers: { some: { policyId: next.id } } } }, select: { endpoint: { select: { hostname: true, name: true } }, policy: { select: { name: true, revision: true } } } });
        result = { code: 'waiting_for_computer', message: `Revision ${next.revision} waits: ${held ? `${held.endpoint.hostname ?? held.endpoint.name} is still patched by "${held.policy.name}"${held.policy.revision ? ` (revision ${held.policy.revision})` : ''}` : 'a computer it names is still patched by another policy'}. It takes over once that policy lets it go.` };
      }
    }
    const check = (s.lastCheck ?? {}) as unknown as Check;
    if (JSON.stringify(check.promotion ?? null) !== JSON.stringify(result)) {
      await this.prisma.patchPolicySeries.update({ where: { id: s.id }, data: { lastCheck: { ...check, promotion: result } as unknown as Prisma.InputJsonValue } });
    }
    return result;
  }

  private async record(s: PatchPolicySeries, o: { code: string; message: string; until?: Date | null }, d: Desired | null, now: Date) {
    const prev = (s.lastCheck ?? null) as unknown as Check | null;
    const next: Check = {
      at: now.toISOString(), code: o.code, message: o.message, until: o.until ? o.until.toISOString() : null,
      members: d?.rings.flat().length ?? prev?.members ?? 0, rings: d?.rings.map((r) => r.length) ?? prev?.rings ?? [],
      canary: d?.canary ?? prev?.canary ?? null, leftOut: (d?.leftOut ?? prev?.leftOut ?? []).slice(0, 300), lastRingOnly: (d?.lastRingOnly ?? prev?.lastRingOnly ?? []).slice(0, 25),
      promotion: prev?.promotion ?? null,
    };
    const same = prev && JSON.stringify({ ...prev, at: '' }) === JSON.stringify({ ...next, at: '' });
    if (!same) await this.prisma.patchPolicySeries.update({ where: { id: s.id }, data: { lastCheck: next as unknown as Prisma.InputJsonValue } });
  }

  /** A revision was revoked by a person or on the signer: the series ends, so nothing proposes it again. */
  async onRevoked(r: PatchPolicy, by: 'portal' | 'approval signer', actorId: string | null) {
    if (!r.seriesId) return;
    const s = await this.prisma.patchPolicySeries.findUnique({ where: { id: r.seriesId } });
    if (!s || s.status !== 'active') return;
    await this.end(s, `revision ${r.revision} was revoked on the ${by}`, actorId);
  }

  private async end(s: PatchPolicySeries, reason: string, actorId: string | null, actor?: ActorContext) {
    const w = await this.prisma.patchPolicySeries.updateMany({ where: { id: s.id, status: 'active' }, data: { status: 'retired', retiredAt: new Date(), retiredById: actorId, retireReason: reason.slice(0, 300), currentPolicyId: null } });
    if (w.count !== 1) return false;
    for (const p of await this.prisma.patchPolicy.findMany({ where: { seriesId: s.id, status: { in: ['ACTIVE', 'AWAITING_APPROVAL'] } } })) {
      await this.policies.withdraw(p, `the policy was retired: ${reason}`, { seriesId: s.id, revision: p.revision });
    }
    await this.audit.log({ tenantId: s.tenantId ?? undefined, customerId: s.customerId, actorId: actorId ?? undefined, actorIp: actor?.ip, action: 'PATCH_POLICY_SERIES_RETIRED', resource: 'patch_policy_series', resourceId: s.id, meta: { reason, scope: s.scope, name: s.name } });
    return true;
  }

  // ── People ────────────────────────────────────────────────────────────────

  /** Create a company-wide or assignable policy. A company-wide one proposes its first revision now, through the same admission as any policy. */
  async create(actor: ActorContext, raw: unknown, now = new Date()) {
    const parsed = CreateSeriesDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data;
    if (!this.mayManage(actor, dto.businessId)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'A company-wide or assignable patch policy is created by a Business Owner of the business or a Platform Admin.' });
    const biz = await this.prisma.customer.findUnique({ where: { id: dto.businessId }, select: { id: true, tenantId: true, isActive: true, isArchived: true } });
    if (!biz || !biz.isActive || biz.isArchived) throw new NotFoundException('Business not found');
    if (dto.canaryEndpointId) {
      const c = await this.prisma.endpoint.findFirst({ where: { id: dto.canaryEndpointId, customerId: dto.businessId }, select: { id: true } });
      if (!c) this.bad('INVALID_REQUEST', 'The chosen canary is not a computer of this business.');
    }
    const { businessId, scope, name, ...rest } = dto;
    const settings = SeriesSettings.parse(rest);
    let s: PatchPolicySeries;
    try {
      s = await this.prisma.patchPolicySeries.create({ data: { tenantId: biz.tenantId, customerId: businessId, scope, name, settings: settings as unknown as Prisma.InputJsonValue, createdById: actor.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'SERIES_EXISTS', message: 'This business already has a company-wide patch policy. Retire it first, or create an assignable policy for some of its computers.' });
      throw e;
    }
    let first: { code: string; message: string } = { code: 'no_revision', message: scope === 'assigned' ? 'No computer uses this policy yet. Set a computer\'s Patch policy to it; the first revision follows.' : '' };
    if (scope === 'business') {
      const d = await this.desired(s, actor, null, now);
      if (!d.ok) {
        await this.prisma.patchPolicySeries.delete({ where: { id: s.id } });
        throw new ConflictException({ code: d.code.toUpperCase(), message: d.message, leftOut: d.leftOut });
      }
      try {
        await this.prisma.patchPolicySeries.update({ where: { id: s.id }, data: { lastRevision: 1 } });
        const out = await this.policies.admit(actor, {
          businessId, name, rings: d.rings, staging: seriesStaging(settings), allow: settings.allow, soakHours: settings.soakHours, failureThreshold: settings.failureThreshold,
          window: settings.window, reboot: settings.reboot, expiresInDays: settings.expiresInDays,
        ...(settings.restart ? { restart: settings.restart } : {}), ...(settings.ignoreRemoteSession ? { ignoreRemoteSession: true as const } : {}),
          reason: revisionReason(name, scope, 1, 'initial', [], []),
        }, now, { seriesId: s.id, revision: 1, supersedesId: null });
        first = { code: 'proposed', message: `Revision 1 proposed: ${out.status === 'ACTIVE' ? 'active at admission (direct mode)' : 'awaiting approval on the approval signer'}.` };
      } catch (e) {
        await this.prisma.patchPolicySeries.delete({ where: { id: s.id } }).catch(() => undefined);
        throw e;
      }
      // A person's revision counts against the business's bound like any other.
      await this.prisma.patchPolicyRevisionClaim.upsert({ where: { customerId: businessId }, create: { customerId: businessId, at: now }, update: { at: now } });
      s = (await this.prisma.patchPolicySeries.findUnique({ where: { id: s.id } }))!;
      await this.record(s, first, d, now);
      await this.promote(s.id, now);
    } else {
      await this.record(s, first, null, now);
    }
    await this.audit.log({
      tenantId: biz.tenantId, customerId: businessId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_POLICY_SERIES_CREATED', resource: 'patch_policy_series', resourceId: s.id,
      meta: { scope, name, window: settings.window, reboot: settings.reboot, restart: settings.restart ?? null, ...(settings.ignoreRemoteSession ? { ignoreRemoteSession: true } : {}), expiresInDays: settings.expiresInDays, staging: seriesStaging(settings), canaryEndpointId: settings.canaryEndpointId ?? null, reason: settings.reason },
    });
    return this.one(actor, s.id);
  }

  async retire(actor: ActorContext, id: string, raw: unknown) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'A reason of at least 3 characters is required.');
    const s = Id.safeParse(id).success ? await this.prisma.patchPolicySeries.findUnique({ where: { id } }) : null;
    if (!s || !(await this.visible(actor, s.customerId))) throw new NotFoundException('Policy not found');
    if (!this.mayManage(actor, s.customerId) && s.createdById !== actor.userId) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the policy, a Business Owner of this business or a Platform Admin can retire it.' });
    if (s.status !== 'active') throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: 'The policy is already retired.' });
    await this.end(s, dto.data!.reason, actor.userId, actor);
    return this.one(actor, s.id);
  }

  private async visible(actor: ActorContext, businessId: string) {
    return actor.isPlatformAdmin || actor.businessId === businessId;
  }

  private async one(actor: ActorContext, id: string) {
    const s = await this.prisma.patchPolicySeries.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Policy not found');
    return (await this.view(actor, [s]))[0];
  }

  private async view(actor: ActorContext, rows: PatchPolicySeries[]) {
    const out = [];
    for (const s of rows) {
      const revs = await this.prisma.patchPolicy.findMany({ where: { seriesId: s.id }, orderBy: { revision: 'desc' }, take: 10, select: { id: true, revision: true, status: true, expiresAt: true, createdAt: true, supersededAt: true, approvalUrl: true, document: true } });
      const users = await this.prisma.endpoint.count({ where: { patchPolicySeriesId: s.id } });
      out.push({
        id: s.id, businessId: s.customerId, scope: s.scope, name: s.name, status: s.status, settings: s.settings, createdAt: s.createdAt, createdById: s.createdById,
        retiredAt: s.retiredAt, retireReason: s.retireReason, currentPolicyId: s.currentPolicyId, computersSetToUse: users,
        lastCheck: s.lastCheck,
        // 0.52: when the running revision next installs, so the list can say "next install window: Tue 02:00–04:00".
        nextWindow: nextWindowOf(s, revs.find((r) => r.id === s.currentPolicyId) ?? null),
        // 0.54: the install and restart schedule in plain words, and the next restart window.
        schedule: scheduleOf(s), nextRestartWindow: nextRestartWindowOf(s, revs.find((r) => r.id === s.currentPolicyId) ?? null),
        revisions: revs.map((r) => ({ id: r.id, revision: r.revision, status: r.status, expiresAt: r.expiresAt, createdAt: r.createdAt, supersededAt: r.supersededAt, approvalUrl: r.approvalUrl, running: r.id === s.currentPolicyId, computers: (r.document as unknown as PolicyDoc).rings.flat().length })),
        bounds: { revisionMinutes: revisionMinutes(), settleMinutes: settleMinutes(), maxComputers: maxPolicyComputers(seriesStaging(s.settings as unknown as SeriesSettings)) },
        mayManage: this.mayManage(actor, s.customerId) || s.createdById === actor.userId,
      });
    }
    return out;
  }

  /** The business's series, and each visible computer's setting and effective policy. */
  async list(actor: ActorContext, businessId: string) {
    if (!Id.safeParse(businessId).success) this.bad('INVALID_REQUEST', 'businessId is required');
    if (!(await this.visible(actor, businessId))) throw new NotFoundException('Business not found');
    const rows = await this.prisma.patchPolicySeries.findMany({ where: { customerId: businessId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 50 });
    const eps = await this.prisma.endpoint.findMany({
      where: { AND: [this.acl.endpointVisibilityWhere(actor, businessId), { customerId: businessId, status: { not: 'ARCHIVED' } }] },
      select: { id: true, name: true, hostname: true, patchPolicyMode: true, patchPolicySeriesId: true }, orderBy: { name: 'asc' }, take: 500,
    });
    const computers = [];
    for (const e of eps) computers.push({ id: e.id, hostname: e.hostname ?? e.name, mode: e.patchPolicyMode, seriesId: e.patchPolicySeriesId, effective: (await this.effectiveOf(e.id, rows)).effective });
    return { series: await this.view(actor, rows), computers, mayManage: this.mayManage(actor, businessId), mayEdit: actor.isPlatformAdmin || this.acl.can(actor, CAP.COMPUTERS_EDIT) };
  }

  // ── One computer ──────────────────────────────────────────────────────────

  /** What patches this computer automatically, and why. Precedence: its own setting, then the business's company-wide policy. */
  async effective(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { customerId: true } });
    if (!ep?.customerId) throw new NotFoundException('Computer not found');
    const rows = await this.prisma.patchPolicySeries.findMany({ where: { customerId: ep.customerId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const e = await this.effectiveOf(endpointId, rows);
    const biz = rows.find((s) => s.status === 'active' && s.scope === 'business');
    return {
      ...e,
      choices: rows.filter((s) => s.status === 'active' && s.scope === 'assigned').map((s) => ({ id: s.id, name: s.name })),
      companyWide: biz ? { id: biz.id, name: biz.name } : null,
      mayEdit: actor.isPlatformAdmin || this.acl.can(actor, CAP.COMPUTERS_EDIT),
    };
  }

  private async effectiveOf(endpointId: string, rows: PatchPolicySeries[]) {
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { patchPolicyMode: true, patchPolicySeriesId: true } });
    const mode = (ep?.patchPolicyMode ?? 'inherit') as 'inherit' | 'exclude' | 'policy';
    const set = rows.find((s) => s.id === ep?.patchPolicySeriesId) ?? null;
    const live = await this.prisma.patchPolicyComputer.findFirst({ where: { endpointId, live: true }, select: { ring: true, policy: { select: { id: true, name: true, revision: true, seriesId: true, status: true } } } });
    const named = await this.prisma.patchPolicyComputer.findFirst({ where: { endpointId, live: false, policy: { status: { in: ['ACTIVE', 'AWAITING_APPROVAL'] } } }, orderBy: { createdAt: 'desc' }, select: { ring: true, policy: { select: { id: true, name: true, revision: true, seriesId: true, status: true } } } });
    const covering = mode === 'policy' ? set : mode === 'inherit' ? rows.find((s) => s.status === 'active' && s.scope === 'business') ?? null : null;
    const setting = { mode, seriesId: ep?.patchPolicySeriesId ?? null, seriesName: set?.name ?? null };
    const policy = live ? { id: live.policy.id, name: live.policy.name, revision: live.policy.revision, ring: live.ring, seriesId: live.policy.seriesId } : null;
    const ringText = (r: number) => (r === 0 ? 'the canary' : `ring ${r}`);
    let state: 'covered' | 'pending' | 'left_out' | 'excluded' | 'none';
    let why: string;
    if (mode === 'exclude') {
      state = 'excluded';
      why = `Set to Exclude on this computer: no automatic patching.${live ? ` It is still named by "${live.policy.name}"${live.policy.revision ? ` revision ${live.policy.revision}` : ''}, whose sweep leaves it out until a revision drops it.` : ''} Install updates on this tab still works.`;
    } else if (mode === 'policy' && set && set.status !== 'active') {
      state = 'none';
      why = `Set to use "${set.name}", which was retired${set.retireReason ? ` (${set.retireReason})` : ''}: no automatic patching. Choose another setting.`;
    } else if (live && covering && live.policy.seriesId === covering.id) {
      state = 'covered';
      why = `${mode === 'inherit' ? `Inherits the company-wide policy "${covering.name}"` : `Set to use "${covering.name}"`} — revision ${live.policy.revision}, ${ringText(live.ring)}.`;
    } else if (live && !live.policy.seriesId) {
      state = 'covered';
      why = `Named in the policy "${live.policy.name}", made by hand (${ringText(live.ring)}). A hand-made policy keeps it until it is revoked or expires.`;
    } else if (covering) {
      const check = (covering.lastCheck ?? null) as unknown as Check | null;
      const out = check?.leftOut.find((x) => x.endpointId === endpointId);
      const waiting = named && named.policy.seriesId === covering.id ? named : null;
      if (out) { state = 'left_out'; why = `Left out of "${covering.name}": ${out.message}`; }
      else if (waiting) {
        state = 'pending';
        why = `In revision ${waiting.policy.revision} of "${covering.name}" (${ringText(waiting.ring)}), ${waiting.policy.status === 'AWAITING_APPROVAL' ? 'awaiting approval on the approval signer' : 'active and taking over when the running revision has no deployment in progress'}.${live ? ` Until then "${live.policy.name}" patches it.` : ''}`;
      } else {
        state = 'pending';
        why = `Joins "${covering.name}" at its next revision${check ? `: ${check.message}` : '.'}${live ? ` Until then "${live.policy.name}"${live.policy.revision ? ` revision ${live.policy.revision}` : ''} patches it.` : ''}`;
      }
    } else if (live) {
      state = 'covered';
      why = `Patched by "${live.policy.name}"${live.policy.revision ? ` revision ${live.policy.revision}` : ''} (${ringText(live.ring)}) until a revision lets it go.`;
    } else {
      state = 'none';
      why = 'No automatic patching: this business has no company-wide patch policy, and this computer is not set to use another policy.';
    }
    // 0.52: the covering policy's window, and when it next opens for this computer.
    let window: PolicyWindow | null = null;
    let nextWindow: { start: Date; end: Date } | null = null;
    if (live && (state === 'covered')) {
      const doc = await this.prisma.patchPolicy.findUnique({ where: { id: live.policy.id }, select: { document: true, expiresAt: true, status: true } });
      const w = PolicyWindow.safeParse((doc?.document as { window?: unknown } | null)?.window);
      if (w.success) { window = w.data; nextWindow = doc?.status === 'ACTIVE' ? nextOccurrence(new Date(), w.data, doc.expiresAt) : null; }
    } else if (covering) {
      const w = PolicyWindow.safeParse((covering.settings as { window?: unknown } | null)?.window);
      if (w.success) window = w.data;
    }
    return { setting, effective: { state, why, policy, series: covering ? { id: covering.id, name: covering.name, scope: covering.scope } : null, window, nextWindow } };
  }

  /**
   * The one place a computer's Patch policy setting is written. Needs
   * computers:edit on that computer and a fresh sign-in (an everyday change:
   * patching.policy), is conditional on the value read, and is audited with
   * the value before and after. It changes no signed document: a revision
   * follows, under the series' bounds. Exclude also stops the sweep from
   * planning the computer at once.
   */
  async setOverride(actor: ActorContext, endpointId: string, raw: unknown, freshMethod: string | null) {
    await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_EDIT);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    const parsed = OverrideDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_PATCH_POLICY_SETTING', 'The setting is inherit, exclude, or policy with the id of an assignable policy of the same business.');
    const dto = parsed.data!;
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { id: true, tenantId: true, customerId: true, patchPolicyMode: true, patchPolicySeriesId: true } });
    if (!ep?.customerId) throw new NotFoundException('Computer not found');
    let seriesName: string | null = null;
    if (dto.mode === 'policy') {
      const s = await this.prisma.patchPolicySeries.findFirst({ where: { id: dto.seriesId, customerId: ep.customerId, scope: 'assigned', status: 'active' }, select: { name: true } });
      if (!s) throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: 'No active assignable policy of this business has that id.' });
      seriesName = s.name;
    }
    const after = { mode: dto.mode, seriesId: dto.mode === 'policy' ? dto.seriesId : null };
    const before = { mode: ep.patchPolicyMode, seriesId: ep.patchPolicySeriesId };
    if (before.mode === after.mode && before.seriesId === after.seriesId) return { setting: after, changed: false };
    assertFresh(freshMethod, { action: 'patching.override', message: 'Changing which patch policy a computer follows decides what installs on it automatically: confirm it is you.' });
    const w = await this.prisma.endpoint.updateMany({ where: { id: endpointId, patchPolicyMode: before.mode, patchPolicySeriesId: before.seriesId }, data: { patchPolicyMode: after.mode, patchPolicySeriesId: after.seriesId } });
    if (w.count !== 1) throw new ConflictException({ code: 'CHANGED', message: 'This computer\'s setting changed while the request ran; nothing was changed. Reload and try again.' });
    await this.audit.log({
      tenantId: ep.tenantId ?? undefined, customerId: ep.customerId, actorId: actor.userId, actorIp: actor.ip,
      action: 'PATCH_POLICY_OVERRIDE_SET', resource: 'endpoint', resourceId: endpointId,
      meta: { before, after, seriesName, ...(actor.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { setting: after, changed: true };
  }
}

/** 0.54: a series' schedule in words, from its settings (the revisions carry the same). */
function scheduleOf(s: PatchPolicySeries): string | null {
  const st = SeriesSettings.safeParse(s.settings);
  return st.success ? scheduleInWords(st.data) : null;
}

/** 0.54: the next occurrence of a series' restart window, inside its running revision's life. */
function nextRestartWindowOf(s: PatchPolicySeries, current: { status: string; expiresAt: Date } | null, now = new Date()): { start: Date; end: Date } | null {
  if (s.status !== 'active' || !current || current.status !== 'ACTIVE') return null;
  const st = SeriesSettings.safeParse(s.settings);
  return st.success && st.data.restart ? nextOccurrence(now, st.data.restart.window, current.expiresAt) : null;
}

/** 0.52: the next occurrence of a series' window, inside its running revision's life. */
function nextWindowOf(s: PatchPolicySeries, current: { status: string; expiresAt: Date } | null, now = new Date()): { start: Date; end: Date } | null {
  if (s.status !== 'active' || !current || current.status !== 'ACTIVE') return null;
  const w = PolicyWindow.safeParse((s.settings as { window?: unknown } | null)?.window);
  return w.success ? nextOccurrence(now, w.data, current.expiresAt) : null;
}
