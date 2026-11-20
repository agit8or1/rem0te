import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { EndpointListService } from '../endpoints/endpoint-list.service';
import { ruleFilters } from '../device-views/group-rule';
import { ENTITY_ID_RE } from './grant';
import { MsaManagedService } from './msa-managed.service';
import { MsaGrantService } from './msa-grant.service';
import { msaGrantsEnabled, MSA_NOT_ENABLED } from './msa-grants-flag';
import { RUN_BATCH_DEFAULT, RUN_BATCH_MAX, RUN_BATCH_SETTLE_MS, RUN_MEMBERS_MAX, type RunState } from './managed';

const OPEN: RunState[] = ['canary', 'rolling'];
const CODE_RE = /^[A-Z_]{1,40}$/;

/**
 * Managed Secure Access cutover runs (0.73, build step 5), behind MSA_GRANTS.
 * The only writer of MsaCutoverRun and MsaCutoverMember. Every public method
 * asserts the switch first; the controller requires a Platform Admin, and a
 * fresh confirmation (msa.cutover) to start, advance or confirm.
 *
 * A run moves a device group or a business, never the fleet:
 *   - the canary first: one computer, cut over and confirmed the ordinary
 *     way (a managed test session that read back and connected, then a
 *     Platform Admin's confirm). Nothing else moves until it is Managed and
 *     verified;
 *   - then one batch per advance (at most 25, default 5), each computer
 *     through MsaManagedService.cutover — its own blockers, its own audit
 *     row — and a verification grant its agent applies and reads back;
 *   - the next batch waits until every computer of the last one has read
 *     back or failed (or an hour passed);
 *   - nothing advances by itself: there is no timer;
 *   - halt stops it; rollback rolls back every computer this run moved.
 */
@Injectable()
export class MsaCutoverRunService {
  private readonly logger = new Logger('MsaCutoverRuns');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly deviceList: EndpointListService,
    private readonly managed: MsaManagedService,
    private readonly grants: MsaGrantService,
  ) {}

  private assertEnabled() {
    if (!msaGrantsEnabled()) throw new NotFoundException({ code: MSA_NOT_ENABLED, message: 'Managed Secure Access grants are not enabled on this server.' });
  }

  private static codeOf(e: unknown): string {
    if (e instanceof HttpException) {
      const r = e.getResponse() as { code?: unknown } | string;
      const c = typeof r === 'object' && r && typeof r.code === 'string' ? r.code : null;
      if (c && CODE_RE.test(c)) return c;
    }
    return 'MSA_CUTOVER_REFUSED';
  }

  /** The computers a run covers, as this Platform Admin sees them: the group's (static or rule) or the business's, not archived. */
  private async resolveMembers(actor: ActorContext, businessId: string, groupId: string | null): Promise<string[]> {
    const base = { AND: [this.acl.endpointVisibilityWhere(actor, businessId), { customerId: businessId, status: { not: 'ARCHIVED' as const } }] };
    if (!groupId) {
      return (await this.prisma.endpoint.findMany({ where: base, select: { id: true }, orderBy: { id: 'asc' }, take: RUN_MEMBERS_MAX + 1 })).map((r) => r.id);
    }
    const g = await this.prisma.endpointGroup.findFirst({ where: { id: groupId, customerId: businessId }, select: { id: true, name: true, kind: true, rule: true, customerId: true } });
    if (!g) throw new NotFoundException('Device group not found in this business');
    if (g.kind === 'RULE') {
      const m = await this.deviceList.evaluateRuleGroups(actor, [{ id: g.id, name: g.name, customerId: businessId, rule: ruleFilters(g.rule) }], { status: 'current' });
      const ids = m.get(g.id);
      if (!ids) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'This rule group selects computers by their alerts, which needs the monitoring:alerts permission.' });
      return [...ids].sort();
    }
    return (await this.prisma.endpointGroupMember.findMany({
      where: { endpointGroupId: g.id, endpoint: base }, select: { endpointId: true }, orderBy: { endpointId: 'asc' }, take: RUN_MEMBERS_MAX + 1,
    })).map((r) => r.endpointId);
  }

  // ── Starting ──────────────────────────────────────────────────────────────

  async start(actor: ActorContext, raw: unknown) {
    this.assertEnabled();
    const b = (raw ?? {}) as Record<string, unknown>;
    const scope = b.scope;
    const businessId = typeof b.businessId === 'string' && ENTITY_ID_RE.test(b.businessId) ? b.businessId : null;
    const groupId = typeof b.groupId === 'string' && ENTITY_ID_RE.test(b.groupId) ? b.groupId : null;
    const canaryIn = typeof b.canaryEndpointId === 'string' && ENTITY_ID_RE.test(b.canaryEndpointId) ? b.canaryEndpointId : null;
    const batchSize = b.batchSize === undefined ? RUN_BATCH_DEFAULT : Number(b.batchSize);
    if ((scope !== 'group' && scope !== 'business') || !businessId || (scope === 'group') !== !!groupId
      || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > RUN_BATCH_MAX) {
      throw new BadRequestException({ code: 'MSA_RUN_INVALID', message: `Name a business (and, for a group run, its device group), and a batch size from 1 to ${RUN_BATCH_MAX}.` });
    }
    const business = await this.prisma.customer.findFirst({ where: { id: businessId, isArchived: false }, select: { id: true, tenantId: true } });
    if (!business) throw new NotFoundException('Business not found');
    if (await this.prisma.msaCutoverRun.findFirst({ where: { businessId, state: { in: OPEN } }, select: { id: true } })) {
      throw new ConflictException({ code: 'MSA_RUN_OPEN', message: 'This business already has a cutover run in progress. Finish, halt or roll it back first.' });
    }
    const ids = await this.resolveMembers(actor, businessId, groupId);
    if (!ids.length) throw new BadRequestException({ code: 'MSA_RUN_EMPTY', message: 'No computer you can see is in this scope.' });
    if (ids.length > RUN_MEMBERS_MAX) throw new BadRequestException({ code: 'MSA_RUN_TOO_LARGE', message: `A run covers at most ${RUN_MEMBERS_MAX} computers. Use a device group.` });

    const rows = await this.prisma.msaManagedComputer.findMany({ where: { endpointId: { in: ids } }, select: { endpointId: true, state: true } });
    const managed = new Map(rows.map((r) => [r.endpointId, r.state]));
    let canary = canaryIn;
    if (canary && !ids.includes(canary)) throw new BadRequestException({ code: 'MSA_RUN_CANARY_OUTSIDE', message: 'The canary must be one of the run\'s computers.' });
    if (!canary) canary = ids.find((id) => managed.get(id) === 'verified') ?? null;
    if (!canary) {
      for (const id of ids) {
        if (managed.has(id)) continue;
        const v = await this.managed.view(actor, id);
        if (v.cutover.allowed) { canary = id; break; }
      }
    }
    if (!canary) throw new ConflictException({ code: 'MSA_RUN_NO_CANARY', message: 'No computer in this scope can be cut over now (each one\'s blockers are on its page). Nothing was started.' });
    const canaryState = managed.get(canary) ?? null;
    if (canaryState && canaryState !== 'verified' && canaryState !== 'pending') {
      throw new ConflictException({ code: 'MSA_RUN_CANARY_UNFIT', message: `The canary is Managed (${canaryState.replace('_', ' ')}); choose another.` });
    }
    if (!canaryState) {
      const v = await this.managed.view(actor, canary);
      if (!v.cutover.allowed) throw new ConflictException({ code: v.cutover.blockers[0]?.code ?? 'MSA_CUTOVER_REFUSED', message: `The canary cannot be cut over: ${v.cutover.blockers[0]?.message ?? 'refused'}`, blockers: v.cutover.blockers });
    }
    const canaryVerified = canaryState === 'verified';

    await this.audit.logOrFail({
      action: 'MSA_CUTOVER_RUN_STARTED', actorId: actor.userId, actorIp: actor.ip, tenantId: business.tenantId, customerId: businessId,
      resource: 'customer', resourceId: businessId, meta: { scope, businessId, groupId, canaryEndpointId: canary, batchSize, computers: ids.length },
    });
    const now = new Date();
    const run = await this.prisma.$transaction(async (tx) => {
      const r = await tx.msaCutoverRun.create({
        data: {
          scope, businessId, groupId, canaryEndpointId: canary!, batchSize, createdById: actor.userId,
          state: canaryVerified ? 'rolling' : 'canary', canaryVerifiedAt: canaryVerified ? now : null,
        },
      });
      await tx.msaCutoverMember.createMany({
        data: ids.map((id) => {
          const st = managed.get(id);
          if (id === canary) {
            return { runId: r.id, endpointId: id, canary: true, state: canaryVerified ? 'verified' : st ? 'cut_over' : 'queued', ...(st ? { cutAt: now } : {}), ...(canaryVerified ? { verifiedAt: now } : {}) };
          }
          return st ? { runId: r.id, endpointId: id, state: 'skipped', skipReason: 'MSA_ALREADY_MANAGED' } : { runId: r.id, endpointId: id };
        }),
      });
      return r;
    });
    if (!canaryState) {
      try {
        await this.managed.cutover(actor, canary, run.id);
        await this.prisma.msaCutoverMember.updateMany({ where: { runId: run.id, endpointId: canary, state: 'queued' }, data: { state: 'cut_over', cutAt: new Date(), batch: 0 } });
      } catch (e) {
        await this.prisma.msaCutoverMember.updateMany({ where: { runId: run.id, endpointId: canary }, data: { state: 'skipped', skipReason: MsaCutoverRunService.codeOf(e) } });
        await this.prisma.msaCutoverRun.updateMany({ where: { id: run.id, state: 'canary' }, data: { state: 'halted', haltedAt: new Date(), haltedById: actor.userId } });
        throw e;
      }
    }
    return this.view(actor, run.id);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private async load(runId: string) {
    if (!/^[a-z0-9]{20,40}$/.test(runId)) throw new NotFoundException('Run not found');
    const run = await this.prisma.msaCutoverRun.findUnique({
      where: { id: runId },
      include: { business: { select: { name: true } }, group: { select: { name: true } }, members: { orderBy: [{ canary: 'desc' }, { endpointId: 'asc' }] } },
    });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  /** Bring members up to date with their computers (verified, failed, rolled back) — states only, never a cutover. */
  private async sync(runId: string) {
    const members = await this.prisma.msaCutoverMember.findMany({ where: { runId, state: { in: ['cut_over', 'verified'] } }, select: { endpointId: true, state: true } });
    if (!members.length) return;
    const rows = await this.prisma.msaManagedComputer.findMany({ where: { endpointId: { in: members.map((m) => m.endpointId) } }, select: { endpointId: true, state: true, verifiedAt: true } });
    const byId = new Map(rows.map((r) => [r.endpointId, r]));
    for (const m of members) {
      const r = byId.get(m.endpointId);
      if (!r) await this.prisma.msaCutoverMember.updateMany({ where: { runId, endpointId: m.endpointId, state: m.state }, data: { state: 'rolled_back' } });
      else if (r.state === 'verified' && m.state === 'cut_over') await this.prisma.msaCutoverMember.updateMany({ where: { runId, endpointId: m.endpointId, state: 'cut_over' }, data: { state: 'verified', verifiedAt: r.verifiedAt ?? new Date() } });
      else if (r.state === 'enforcement_failure' && m.state === 'cut_over') await this.prisma.msaCutoverMember.updateMany({ where: { runId, endpointId: m.endpointId, state: 'cut_over' }, data: { state: 'failed' } });
    }
  }

  /** Whether the next batch may go, and why not. */
  private async nextOf(run: Awaited<ReturnType<MsaCutoverRunService['load']>>, now: number): Promise<{ allowed: boolean; reason: string | null }> {
    if (!OPEN.includes(run.state as RunState)) return { allowed: false, reason: `The run is ${run.state.replace('_', ' ')}.` };
    const canary = run.members.find((m) => m.canary);
    if (!run.canaryVerifiedAt && canary?.state !== 'verified') {
      return { allowed: false, reason: 'The canary must be Managed and verified first: send it a test grant, connect through it, then confirm it on its page.' };
    }
    const last = run.members.filter((m) => !m.canary && m.batch === run.batches && m.state === 'cut_over');
    if (run.batches > 0 && last.length && run.lastBatchAt && now - run.lastBatchAt.getTime() < RUN_BATCH_SETTLE_MS) {
      const rows = await this.prisma.msaManagedComputer.findMany({ where: { endpointId: { in: last.map((m) => m.endpointId) } }, select: { endpointId: true, readbackOkAt: true, requestedAt: true } });
      const waiting = last.filter((m) => {
        const r = rows.find((x) => x.endpointId === m.endpointId);
        return r && (!r.readbackOkAt || r.readbackOkAt < r.requestedAt);
      });
      if (waiting.length) return { allowed: false, reason: `${waiting.length} computer(s) of the last batch have not read their settings back yet (the next batch waits up to an hour).` };
    }
    if (!run.members.some((m) => m.state === 'queued')) return { allowed: false, reason: 'Every computer in the run has been moved or skipped.' };
    return { allowed: true, reason: null };
  }

  async view(actor: ActorContext, runId: string, now = Date.now()) {
    this.assertEnabled();
    await this.sync(runId);
    const run = await this.load(runId);
    const ids = run.members.map((m) => m.endpointId);
    const [eps, rows] = await Promise.all([
      this.prisma.endpoint.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, hostname: true } }),
      this.prisma.msaManagedComputer.findMany({ where: { endpointId: { in: ids } }, select: { endpointId: true, state: true } }),
    ]);
    const name = new Map(eps.map((e) => [e.id, e.hostname ?? e.name]));
    const st = new Map(rows.map((r) => [r.endpointId, r.state]));
    const counts: Record<string, number> = { total: run.members.length, queued: 0, cut_over: 0, verified: 0, skipped: 0, failed: 0, rolled_back: 0 };
    for (const m of run.members) counts[m.state] = (counts[m.state] ?? 0) + 1;
    return {
      id: run.id, scope: run.scope, businessId: run.businessId, businessName: run.business?.name ?? null, groupId: run.groupId, groupName: run.group?.name ?? null,
      canaryEndpointId: run.canaryEndpointId, canaryName: name.get(run.canaryEndpointId) ?? null, batchSize: run.batchSize, state: run.state,
      createdAt: run.createdAt, canaryVerifiedAt: run.canaryVerifiedAt, lastBatchAt: run.lastBatchAt, batches: run.batches,
      counts, next: await this.nextOf(run, now),
      members: run.members.map((m) => ({
        endpointId: m.endpointId, name: name.get(m.endpointId) ?? null, canary: m.canary, state: m.state, skipReason: m.skipReason, batch: m.batch,
        cutAt: m.cutAt, verifiedAt: m.verifiedAt, managedState: st.get(m.endpointId) ?? 'legacy',
      })),
    };
  }

  async list(actor: ActorContext) {
    this.assertEnabled();
    const runs = await this.prisma.msaCutoverRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
    const out = [];
    for (const r of runs) {
      const { members: _m, ...rest } = await this.view(actor, r.id);
      void _m;
      out.push(rest);
    }
    return { runs: out };
  }

  // ── Advancing ─────────────────────────────────────────────────────────────

  /**
   * Move the next batch. Refused until the canary is verified and while the
   * last batch has computers that have not read back (up to an hour). Each
   * computer goes through the one-computer cutover (its blockers, its audit
   * row); one that is refused is skipped with the blocker's code. Each one
   * moved is sent a verification grant.
   */
  async advance(actor: ActorContext, runId: string, now = Date.now()) {
    this.assertEnabled();
    await this.sync(runId);
    let run = await this.load(runId);
    const canary = run.members.find((m) => m.canary);
    if (OPEN.includes(run.state as RunState) && !run.canaryVerifiedAt && canary?.state === 'verified') {
      await this.prisma.msaCutoverRun.updateMany({ where: { id: run.id, state: 'canary', canaryVerifiedAt: null }, data: { state: 'rolling', canaryVerifiedAt: new Date(now) } });
      run = await this.load(runId);
    }
    const next = await this.nextOf(run, now);
    if (!next.allowed) {
      const code = !OPEN.includes(run.state as RunState) ? 'MSA_RUN_CLOSED' : !run.canaryVerifiedAt ? 'MSA_CANARY_NOT_VERIFIED' : run.members.some((m) => m.state === 'queued') ? 'MSA_BATCH_IN_PROGRESS' : 'MSA_RUN_NOTHING_LEFT';
      throw new ConflictException({ code, message: next.reason });
    }
    const batch = run.members.filter((m) => m.state === 'queued').slice(0, run.batchSize).map((m) => m.endpointId);
    const n = run.batches + 1;
    await this.audit.logOrFail({
      action: 'MSA_CUTOVER_RUN_ADVANCED', actorId: actor.userId, actorIp: actor.ip, customerId: run.businessId,
      resource: 'customer', resourceId: run.businessId, meta: { runId: run.id, batch: n, endpointIds: batch },
    });
    const claimed = await this.prisma.msaCutoverRun.updateMany({ where: { id: run.id, batches: run.batches, state: 'rolling' }, data: { batches: n, lastBatchAt: new Date(now) } });
    if (claimed.count !== 1) throw new ConflictException({ code: 'MSA_RUN_CHANGED', message: 'The run changed meanwhile. Reload and try again.' });
    for (const id of batch) {
      try {
        await this.managed.cutover(actor, id, run.id);
        await this.prisma.msaCutoverMember.updateMany({ where: { runId: run.id, endpointId: id, state: 'queued' }, data: { state: 'cut_over', cutAt: new Date(), batch: n } });
      } catch (e) {
        await this.prisma.msaCutoverMember.updateMany({ where: { runId: run.id, endpointId: id, state: 'queued' }, data: { state: 'skipped', skipReason: MsaCutoverRunService.codeOf(e), batch: n } });
        continue;
      }
      try {
        await this.grants.issueVerification(actor, id, Date.now());
      } catch (e) {
        this.logger.warn(`Run ${run.id}: no verification grant for ${id} (${MsaCutoverRunService.codeOf(e)})`);
      }
    }
    if (!(await this.prisma.msaCutoverMember.count({ where: { runId: run.id, state: 'queued' } }))) {
      await this.prisma.msaCutoverRun.updateMany({ where: { id: run.id, state: 'rolling' }, data: { state: 'complete', completedAt: new Date() } });
    }
    return this.view(actor, run.id);
  }

  /**
   * Confirm the run's computers verified: each one cut over by this run
   * (never the canary, which is confirmed on its own page) whose agent
   * applied and read back its verification grant since. Per computer,
   * through MsaManagedService.confirmFromRun (its own audit row).
   */
  async confirm(actor: ActorContext, runId: string) {
    this.assertEnabled();
    await this.sync(runId);
    const run = await this.load(runId);
    if (run.state === 'rolled_back') throw new ConflictException({ code: 'MSA_RUN_CLOSED', message: 'The run was rolled back.' });
    let confirmed = 0;
    for (const m of run.members.filter((x) => x.state === 'cut_over' && !x.canary)) {
      if (await this.managed.confirmFromRun(actor, m.endpointId, run.id)) {
        await this.prisma.msaCutoverMember.updateMany({ where: { runId: run.id, endpointId: m.endpointId, state: 'cut_over' }, data: { state: 'verified', verifiedAt: new Date() } });
        confirmed++;
      }
    }
    await this.audit.log({
      action: 'MSA_CUTOVER_RUN_CONFIRMED', actorId: actor.userId, actorIp: actor.ip, customerId: run.businessId,
      resource: 'customer', resourceId: run.businessId, meta: { runId: run.id, confirmed },
    });
    return { ...(await this.view(actor, run.id)), confirmed };
  }

  /** Stop a run where it is. Never asks; nothing on a computer changes. */
  async halt(actor: ActorContext, runId: string) {
    this.assertEnabled();
    const run = await this.load(runId);
    const moved = await this.prisma.msaCutoverRun.updateMany({ where: { id: run.id, state: { in: OPEN } }, data: { state: 'halted', haltedAt: new Date(), haltedById: actor.userId } });
    if (moved.count !== 1) throw new ConflictException({ code: 'MSA_RUN_CLOSED', message: `The run is ${run.state.replace('_', ' ')}.` });
    await this.audit.log({
      action: 'MSA_CUTOVER_RUN_HALTED', actorId: actor.userId, actorIp: actor.ip, customerId: run.businessId,
      resource: 'customer', resourceId: run.businessId, meta: { runId: run.id, before: run.state },
    });
    return this.view(actor, run.id);
  }

  /**
   * Roll back every computer this run moved (MsaManagedComputer.runId is the
   * run), each through the one-computer rollback. A canary that was already
   * managed before the run is left as it was. Never asks: it only reduces.
   */
  async rollback(actor: ActorContext, runId: string) {
    this.assertEnabled();
    const run = await this.load(runId);
    if (run.state === 'rolled_back') throw new ConflictException({ code: 'MSA_RUN_CLOSED', message: 'The run was already rolled back.' });
    await this.audit.logOrFail({
      action: 'MSA_CUTOVER_RUN_ROLLED_BACK', actorId: actor.userId, actorIp: actor.ip, customerId: run.businessId,
      resource: 'customer', resourceId: run.businessId, meta: { runId: run.id, before: run.state },
    });
    const ours = await this.prisma.msaManagedComputer.findMany({ where: { runId: run.id, state: { not: 'rollback_pending' } }, select: { endpointId: true } });
    let rolled = 0;
    for (const r of ours) {
      try {
        await this.managed.rollback(actor, r.endpointId, false);
        await this.prisma.msaCutoverMember.updateMany({ where: { runId: run.id, endpointId: r.endpointId }, data: { state: 'rolled_back' } });
        rolled++;
      } catch (e) {
        this.logger.warn(`Run ${run.id}: rollback of ${r.endpointId} refused (${MsaCutoverRunService.codeOf(e)})`);
      }
    }
    await this.prisma.msaCutoverRun.updateMany({ where: { id: run.id }, data: { state: 'rolled_back', rolledBackAt: new Date(), rolledBackById: actor.userId } });
    return { ...(await this.view(actor, run.id)), rolledBack: rolled };
  }
}
