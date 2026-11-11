import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContainmentService } from '../containment/containment.service';
import { openSessionReason } from '../admin/session-evidence';
import { ClientUpdatesService } from './client-updates.service';
import { blocker, effectivePolicy, policyWindow } from './policy';
import { describeWindow, isWindowOpen } from './update-window';

/** A live sample older than this does not say who is logged on now. */
const LIVE_SAMPLE_FRESH_MS = 15 * 60_000;
/** A session count the endpoint reported longer ago than this is not evidence about now. */
const SESSION_COUNT_FRESH_MS = 10 * 60_000;
const ROLLOUT_OPEN = ['REQUESTED', 'DISPATCHED', 'INSTALLING', 'AWAITING_VERIFICATION'] as const;

/**
 * The client-update sweep (0.32). Every CLIENT_UPDATE_SWEEP_SECONDS (default
 * 120, minimum 2) it looks at every enabled policy and, for each one whose
 * window is open NOW, queues that scope's outdated computers through the same
 * RustdeskNode.updateRequestedAt path a click on Update uses — marked POLICY,
 * so the heartbeat hands it out only inside the window.
 *
 * What it will queue: a Windows computer in the policy's business (and site,
 * for a site override), not archived, online, with a device secret, that has
 * reported a RustDesk version older than the target (the version pin, else
 * the latest release), with nothing already queued and no staged rollout job.
 * When the policy says so, it also skips a computer with an open session or a
 * logged-on user — the heartbeat checks both again before handing it out.
 *
 * Bounded: at most CLIENT_UPDATE_SWEEP_BATCH (default 25) computers per sweep
 * across every business, so a large fleet is spread over successive sweeps
 * and the RustDesk download is not fetched by everything at once. Each queued
 * computer is audited as CLIENT_UPDATE_AUTO_QUEUED.
 *
 * An "updates" containment pause (global, or this business) skips the
 * business entirely — nothing is queued, and the heartbeat withholds anything
 * queued earlier.
 *
 * CLIENT_UPDATE_SWEEP=off turns it off in this process. Two API instances are
 * safe: the write is conditional on nothing being queued, so a computer is
 * queued — and audited — once.
 */
@Injectable()
export class ClientUpdateSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ClientUpdateSweep');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private warnedNoTarget = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly containment: ContainmentService,
    private readonly svc: ClientUpdatesService,
  ) {}

  onModuleInit() {
    if (process.env.CLIENT_UPDATE_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.CLIENT_UPDATE_SWEEP_SECONDS) || 120) * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  private batch() {
    const n = Number(process.env.CLIENT_UPDATE_SWEEP_BATCH);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 500) : 25;
  }

  async sweep(now = new Date()): Promise<{ queued: number }> {
    if (this.busy) return { queued: 0 };
    this.busy = true;
    try {
      return await this.pass(now);
    } catch (e) {
      this.logger.error(`client-update sweep: ${(e as Error).stack ?? e}`);
      return { queued: 0 };
    } finally { this.busy = false; }
  }

  private async pass(now: Date): Promise<{ queued: number }> {
    const enabled = await this.prisma.clientUpdatePolicy.findMany({
      where: { enabled: true, customer: { isActive: true, isArchived: false } },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    if (!enabled.length) return { queued: 0 };
    const target = await this.svc.targetVersion();
    if (!target.version) {
      if (!this.warnedNoTarget) this.logger.warn('No target RustDesk version (GitHub unreachable and no pin): nothing queued.');
      this.warnedNoTarget = true;
      return { queued: 0 };
    }
    this.warnedNoTarget = false;

    let budget = this.batch();
    let queued = 0;
    for (const { customerId } of enabled) {
      if (budget <= 0) break;
      if (await this.containment.blocking('updates', customerId)) continue;
      const policies = await this.prisma.clientUpdatePolicy.findMany({ where: { customerId } });
      // Only scopes whose window is open now: a business row covers the
      // computers of every site without its own override.
      const open = policies.filter((p) => p.enabled && isWindowOpen(policyWindow(p), now));
      if (!open.length) continue;

      const candidates = await this.prisma.endpoint.findMany({
        where: {
          customerId, status: { not: 'ARCHIVED' }, isOnline: true,
          platform: { contains: 'windows', mode: 'insensitive' },
          rustdeskNode: { agentSecretHash: { not: null }, version: { not: null }, updateRequestedAt: null },
        },
        select: {
          id: true, tenantId: true, name: true, status: true, isOnline: true, platform: true, siteId: true,
          rustdeskNode: { select: { id: true, version: true, agentSecretHash: true, updateRequestedAt: true, rdSessionsActive: true, rdSessionsObservedAt: true } },
          inventory: { select: { loggedOnUser: true, liveSampledAt: true } },
        },
        orderBy: { name: 'asc' },
      });
      const inRollout = new Set((await this.prisma.updateJob.findMany({
        where: { endpointId: { in: candidates.map((c) => c.id) }, status: { in: [...ROLLOUT_OPEN] } },
        select: { endpointId: true },
      })).map((j) => j.endpointId));

      for (const e of candidates) {
        if (budget <= 0) break;
        const p = effectivePolicy(policies, customerId, e.siteId);
        if (!p || !open.some((o) => o.id === p.id)) continue;
        const n = e.rustdeskNode!;
        if (blocker({ status: e.status, isOnline: e.isOnline, platform: e.platform, node: n, inRollout: inRollout.has(e.id) }, target.version)) continue;
        if (p.skipActiveSession) {
          const reported = n.rdSessionsObservedAt && now.getTime() - n.rdSessionsObservedAt.getTime() < SESSION_COUNT_FRESH_MS ? n.rdSessionsActive : null;
          if (await openSessionReason(this.prisma, e.id, reported, now, true)) continue;
        }
        if (p.skipLoggedOnUser) {
          const s = e.inventory;
          const fresh = !!s?.liveSampledAt && now.getTime() - s.liveSampledAt.getTime() < LIVE_SAMPLE_FRESH_MS;
          if (!fresh || s?.loggedOnUser) continue;
        }
        const w = await this.prisma.rustdeskNode.updateMany({
          where: { id: n.id, updateRequestedAt: null },
          data: {
            updateRequestedAt: now, updateTargetVersion: target.version, updateRequestSource: 'POLICY',
            updateRequestedById: null, updateHoldReason: null, updateHoldAt: null,
          },
        });
        if (w.count !== 1) continue;
        budget--; queued++;
        await this.audit.log({
          tenantId: e.tenantId ?? undefined, customerId,
          action: 'CLIENT_UPDATE_AUTO_QUEUED', resource: 'endpoint', resourceId: e.id,
          meta: {
            policyId: p.id, scope: p.siteId ? 'site' : 'business', siteId: p.siteId,
            rustdeskFrom: n.version, rustdeskTo: target.version, pinned: target.pinned,
            window: describeWindow(policyWindow(p)),
          },
        });
      }
    }
    if (queued) this.logger.log(`queued ${queued} computer(s) for RustDesk ${target.version}`);
    return { queued };
  }
}
