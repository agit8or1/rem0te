import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ClientUpdatePolicy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ContainmentService } from '../containment/containment.service';
import { latestRustdeskVersion } from '../common/rustdesk-release';
import { openSessionReason } from '../admin/session-evidence';
import {
  BLOCKER, blocker, effectivePolicy, HOLD_TEXT, policyHold, PolicyInput, policyWindow, type HoldReason,
} from './policy';
import { describeWindow, parseUpdateWindow, windowState } from './update-window';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const ROLLOUT_OPEN = ['REQUESTED', 'DISPATCHED', 'INSTALLING', 'AWAITING_VERIFICATION'] as const;

/** Thrown to the controller when a write needs fresh authentication it does not have. */
export class FreshAuthNeeded extends Error {}

/**
 * Scheduled RustDesk client updates (0.32): the policy, who may set it, what
 * each computer will do, and the heartbeat's decision for a POLICY request.
 *
 * Who may change a business's policy — it makes the server re-run an
 * installer on that business's computers unattended, which is more than
 * staging one computer:
 *   - the MSP (Platform Admin, or technicians:manage when not acting as a
 *     technician): any business;
 *   - a Business Owner: their own business only;
 *   - a technician: only in a business where one assignment grants
 *     computers:edit over the WHOLE business. An assignment limited to named
 *     computers cannot set a policy that reaches every computer.
 *   A Business User cannot, whatever they hold: computers:edit is granted per
 *   business but a Business User may see only some of its computers, and the
 *   policy reaches all of them.
 * Turning a policy on (or saving one that stays on, or removing a site
 * override, which can hand a site to an enabled business policy) also needs
 * fresh authentication. Turning it off never does: stopping is never harder
 * than starting.
 *
 * Reading the policy and the per-computer view needs computers:view, and
 * shows only the computers this person can see.
 */
@Injectable()
export class ClientUpdatesService {
  private readonly logger = new Logger('ClientUpdates');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly containment: ContainmentService,
  ) {}

  // ── Who ───────────────────────────────────────────────────────────────────

  isMsp(a: ActorContext) {
    return a.isPlatformAdmin || (!a.technician && (a.platformPermissions ?? []).includes('technicians:manage' as never));
  }

  /** The business a request is about. Throws outside the caller's reach. */
  private scope(a: ActorContext, requested?: string | null): string {
    if (requested && !ID.test(requested)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is not an id' });
    if (this.isMsp(a) && !a.isPlatformAdmin) {
      const b = requested ?? a.businessId;
      if (!b) throw new BadRequestException({ code: 'BUSINESS_REQUIRED', message: 'Pick a business.' });
      return b;
    }
    const s = this.acl.resolveScope(a, requested);
    if (!s) throw new BadRequestException({ code: 'BUSINESS_REQUIRED', message: 'Pick a business.' });
    return s;
  }

  /** May this person change the policy of `customerId`? Returns the refusal, or null. */
  editRefusal(a: ActorContext, customerId: string): string | null {
    if (this.isMsp(a)) return null;
    if (a.technician) {
      if (a.technician.businessId !== customerId) return 'You are not assigned to this business.';
      const whole = a.technician.sources.some((s) => (s.capabilities as string[]).includes(CAP.COMPUTERS_EDIT) && s.endpointIds === null);
      return whole ? null : 'Changing the update policy needs an assignment that grants computers:edit over the whole business.';
    }
    if (a.businessId !== customerId) return 'You do not have access to that business.';
    if (!a.isPlatformAdmin && this.acl.isBusinessOwner(a)) return null;
    return 'The update policy is set by a Business Owner of this business, a technician with computers:edit over the whole business, or the MSP.';
  }

  private assertEdit(a: ActorContext, customerId: string) {
    const why = this.editRefusal(a, customerId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
  }

  private assertView(a: ActorContext, customerId: string) {
    if (this.isMsp(a) || this.editRefusal(a, customerId) === null) return;
    if (a.technician) {
      if (!a.technician.sources.some((s) => (s.capabilities as string[]).includes(CAP.COMPUTERS_VIEW))) {
        throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Seeing client updates needs computers:view.' });
      }
      return;
    }
    if (!this.acl.can(a, CAP.COMPUTERS_VIEW)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Seeing client updates needs computers:view.' });
  }

  /** Computers this person may see in `customerId`. */
  private visible(a: ActorContext, customerId: string): Prisma.EndpointWhereInput {
    if (this.isMsp(a)) return { customerId };
    return { AND: [{ customerId }, this.acl.endpointVisibilityWhere(a, customerId)] };
  }

  private async business(customerId: string) {
    const b = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, tenantId: true } });
    if (!b) throw new NotFoundException('Business not found');
    return b;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async targetVersion(): Promise<{ version: string | null; pinned: boolean }> {
    const pin = (await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { rustdeskPinnedVersion: true } }))?.rustdeskPinnedVersion ?? null;
    return pin ? { version: pin, pinned: true } : { version: await latestRustdeskVersion(), pinned: false };
  }

  private view(p: ClientUpdatePolicy | null, now: Date) {
    if (!p) return null;
    const w = policyWindow(p);
    const st = windowState(w, now);
    return {
      id: p.id, siteId: p.siteId, enabled: p.enabled, timeZone: p.timeZone, windows: p.windows,
      skipActiveSession: p.skipActiveSession, skipLoggedOnUser: p.skipLoggedOnUser,
      description: describeWindow(w), valid: !!w,
      window: { open: st.open, opensAt: st.opensAt, closesAt: st.closesAt },
      updatedAt: p.updatedAt, updatedById: p.updatedById,
    };
  }

  async getPolicy(a: ActorContext, requested?: string | null) {
    const customerId = this.scope(a, requested);
    this.assertView(a, customerId);
    const biz = await this.business(customerId);
    const now = new Date();
    const [policies, sites, paused, target] = await Promise.all([
      this.prisma.clientUpdatePolicy.findMany({ where: { customerId } }),
      this.prisma.site.findMany({ where: { customerId }, select: { id: true, name: true, timezone: true }, orderBy: { name: 'asc' } }),
      this.containment.blocking('updates', customerId),
      this.targetVersion(),
    ]);
    const refusal = this.editRefusal(a, customerId);
    return {
      business: { id: biz.id, name: biz.name },
      policy: this.view(policies.find((p) => p.siteId === null) ?? null, now),
      sites: sites.map((s) => ({ ...s, override: this.view(policies.find((p) => p.siteId === s.id) ?? null, now) })),
      target,
      containment: paused ? { paused: true, scope: paused.scope.toLowerCase(), reason: paused.reason } : { paused: false },
      may: { edit: refusal === null, reason: refusal },
      sweep: { enabled: process.env.CLIENT_UPDATE_SWEEP !== 'off' },
      now,
    };
  }

  /**
   * Every computer this person can see in the business, and what automatic
   * updating will do with it — including, honestly, when the answer is never.
   */
  async computers(a: ActorContext, requested?: string | null) {
    const customerId = this.scope(a, requested);
    this.assertView(a, customerId);
    const now = new Date();
    const [policies, target, rows] = await Promise.all([
      this.prisma.clientUpdatePolicy.findMany({ where: { customerId } }),
      this.targetVersion(),
      this.prisma.endpoint.findMany({
        where: this.visible(a, customerId),
        select: {
          id: true, name: true, status: true, isOnline: true, platform: true, siteId: true, lastSeenAt: true,
          site: { select: { id: true, name: true } },
          rustdeskNode: {
            select: {
              version: true, agentSecretHash: true, updateRequestedAt: true, updateTargetVersion: true,
              updateRequestSource: true, updateRequestedById: true, updateHoldReason: true, updateHoldAt: true,
            },
          },
        },
        orderBy: { name: 'asc' },
        take: 2000,
      }),
    ]);
    const inRollout = new Set((await this.prisma.updateJob.findMany({
      // Any open job, either component: while one exists the heartbeat lets
      // the rollout decide and one-click staging does not fire.
      where: { endpointId: { in: rows.map((r) => r.id) }, status: { in: [...ROLLOUT_OPEN] } },
      select: { endpointId: true },
    })).map((j) => j.endpointId));
    const byIds = [...new Set(rows.map((r) => r.rustdeskNode?.updateRequestedById).filter((x): x is string => !!x))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: byIds } }, select: { id: true, firstName: true, lastName: true, email: true } }))
      .map((u) => [u.id, { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email }]));

    // One window computation per policy, not per computer: it scans minutes.
    const states = new Map(policies.map((p) => [p.id, windowState(policyWindow(p), now)]));
    return {
      target,
      computers: rows.map((r) => {
        const n = r.rustdeskNode;
        const p = effectivePolicy(policies, customerId, r.siteId);
        const st = (p && states.get(p.id)) || { open: false, opensAt: null, closesAt: null };
        const policy = p ? { id: p.id, scope: p.siteId ? 'site' : 'business', enabled: p.enabled, window: { open: st.open, opensAt: st.opensAt, closesAt: st.closesAt } } : null;
        const base = {
          id: r.id, name: r.name, site: r.site, platform: r.platform, isOnline: r.isOnline, lastSeenAt: r.lastSeenAt,
          version: n?.version ?? null, policy,
        };
        if (n?.updateRequestedAt) {
          const manual = n.updateRequestSource !== 'POLICY';
          const hold = (n.updateHoldReason ?? null) as HoldReason | null;
          return {
            ...base,
            state: manual ? 'queued_manual' : (hold ? 'queued_auto_waiting' : 'queued_auto'),
            queued: {
              at: n.updateRequestedAt, targetVersion: n.updateTargetVersion, source: manual ? 'manual' : 'policy',
              by: manual ? (n.updateRequestedById ? users.get(n.updateRequestedById) ?? { id: n.updateRequestedById, name: 'a user no longer here' } : null) : null,
              hold: hold ? { reason: hold, text: HOLD_TEXT[hold] ?? hold, since: n.updateHoldAt } : null,
            },
            text: manual
              ? `Queued by ${n.updateRequestedById ? users.get(n.updateRequestedById)?.name ?? 'a user no longer here' : 'hand (before 0.32)'} — goes on the next heartbeat.`
              : hold ? `Auto — ${HOLD_TEXT[hold] ?? hold}.` : st.open ? 'Auto — queued; goes on its next heartbeat inside the window.' : 'Auto — queued, waiting for the window.',
          };
        }
        const b = blocker({ status: r.status, isOnline: r.isOnline, platform: r.platform, node: n ? { agentSecretHash: n.agentSecretHash, version: n.version, updateRequestedAt: n.updateRequestedAt } : null, inRollout: inRollout.has(r.id) }, target.version);
        if (b) return { ...base, state: b === 'up_to_date' ? 'current' : 'blocked', blocker: { code: b, permanent: BLOCKER[b].permanent }, text: BLOCKER[b].text };
        if (!p || !p.enabled) return { ...base, state: 'manual_only', text: 'Outdated. No update policy is on here, so it updates only when someone clicks Update.' };
        if (!target.version) return { ...base, state: 'blocked', blocker: { code: 'no_target', permanent: false }, text: 'The latest RustDesk version is unknown right now (GitHub unreachable and no pin), so nothing is queued.' };
        return { ...base, state: 'eligible', text: st.open ? 'Outdated — will be queued by the next sweep.' : 'Outdated — will be queued when the window opens.' };
      }),
    };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  private async siteOf(customerId: string, siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true, customerId: true, name: true } });
    // NotFound, not Forbidden, for another business's site: an id from
    // elsewhere learns nothing about whether it exists.
    if (!site || site.customerId !== customerId) throw new NotFoundException('Site not found');
    return site;
  }

  private snapshot(p: ClientUpdatePolicy | null) {
    return p ? { enabled: p.enabled, timeZone: p.timeZone, windows: p.windows, skipActiveSession: p.skipActiveSession, skipLoggedOnUser: p.skipLoggedOnUser } : null;
  }

  async putPolicy(a: ActorContext, raw: unknown, fresh: boolean) {
    const parsed = PolicyInput.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    const input = parsed.data;
    const customerId = this.scope(a, input.businessId);
    this.assertEdit(a, customerId);
    let window;
    try { window = parseUpdateWindow(input.timeZone, input.windows); } catch (e) {
      throw new BadRequestException({ code: 'INVALID_WINDOW', message: (e as Error).message });
    }
    const siteId = input.siteId ?? null;
    if (siteId) await this.siteOf(customerId, siteId);
    if (input.enabled && !fresh) throw new FreshAuthNeeded();
    const biz = await this.business(customerId);

    const data = {
      enabled: input.enabled, timeZone: window.timeZone, windows: window.windows as unknown as Prisma.InputJsonValue,
      skipActiveSession: input.skipActiveSession, skipLoggedOnUser: input.skipLoggedOnUser, updatedById: a.userId,
    };
    const before = await this.prisma.clientUpdatePolicy.findFirst({ where: { customerId, siteId } });
    const after = before
      ? await this.prisma.clientUpdatePolicy.update({ where: { id: before.id }, data })
      : await this.prisma.clientUpdatePolicy.create({ data: { ...data, tenantId: biz.tenantId, customerId, siteId } });
    const cleared = await this.clearUnwanted(customerId);

    await this.audit.log({
      tenantId: biz.tenantId, customerId, actorId: a.userId, actorIp: a.ip,
      action: 'CLIENT_UPDATE_POLICY_CHANGED', resource: 'client_update_policy', resourceId: after.id,
      meta: {
        scope: siteId ? 'site' : 'business', siteId, before: this.snapshot(before), after: this.snapshot(after),
        window: describeWindow(window), clearedQueued: cleared,
        ...(a.technician ? { viaTechnicianAssignment: true } : {}),
      },
    });
    return { policy: this.view(after, new Date()), clearedQueued: cleared };
  }

  async deleteSiteOverride(a: ActorContext, requested: string | null | undefined, siteId: string, fresh: boolean) {
    if (!ID.test(siteId)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'siteId is not an id' });
    const customerId = this.scope(a, requested);
    this.assertEdit(a, customerId);
    await this.siteOf(customerId, siteId);
    const before = await this.prisma.clientUpdatePolicy.findFirst({ where: { customerId, siteId } });
    if (!before) throw new NotFoundException('This site has no override');
    // The site falls back to the business policy, which may be on.
    if (!fresh) throw new FreshAuthNeeded();
    const biz = await this.business(customerId);
    await this.prisma.clientUpdatePolicy.delete({ where: { id: before.id } });
    const cleared = await this.clearUnwanted(customerId);
    await this.audit.log({
      tenantId: biz.tenantId, customerId, actorId: a.userId, actorIp: a.ip,
      action: 'CLIENT_UPDATE_POLICY_CHANGED', resource: 'client_update_policy', resourceId: before.id,
      meta: { scope: 'site', siteId, before: this.snapshot(before), after: null, removedOverride: true, clearedQueued: cleared, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { removed: true, clearedQueued: cleared };
  }

  /**
   * POLICY requests in this business whose computer is no longer governed by
   * an enabled policy are withdrawn: turning a policy off must stop what it
   * queued, not leave it waiting for a window that is no longer meant to
   * install anything. MANUAL requests are never touched here.
   */
  private async clearUnwanted(customerId: string): Promise<number> {
    const policies = await this.prisma.clientUpdatePolicy.findMany({ where: { customerId } });
    const queued = await this.prisma.rustdeskNode.findMany({
      where: { updateRequestSource: 'POLICY', updateRequestedAt: { not: null }, endpoint: { customerId } },
      select: { id: true, endpoint: { select: { siteId: true } } },
    });
    const drop = queued.filter((n) => !effectivePolicy(policies, customerId, n.endpoint.siteId)?.enabled).map((n) => n.id);
    if (!drop.length) return 0;
    const r = await this.prisma.rustdeskNode.updateMany({
      where: { id: { in: drop }, updateRequestSource: 'POLICY' },
      data: { updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null, updateRequestedById: null, updateHoldReason: null, updateHoldAt: null },
    });
    return r.count;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /**
   * For an authenticated heartbeat on a node with a POLICY request: may it be
   * handed out now? Returns the hold reason, or null to hand it out. Records
   * the reason on the node when it changes, so the console can say why a
   * computer is waiting. Never called for a MANUAL request.
   */
  async holdForHeartbeat(
    node: { id: string; endpointId: string; updateHoldReason: string | null },
    facts: { rustdeskSessions?: number; loggedOnUser?: string },
    now = new Date(),
  ): Promise<HoldReason | null> {
    const ep = await this.prisma.endpoint.findUnique({ where: { id: node.endpointId }, select: { customerId: true, siteId: true } });
    const policies = ep?.customerId ? await this.prisma.clientUpdatePolicy.findMany({ where: { customerId: ep.customerId } }) : [];
    const p = effectivePolicy(policies, ep?.customerId ?? null, ep?.siteId ?? null);
    // Session evidence is only gathered when it can matter.
    const sessionOpen = !!(p?.enabled && p.skipActiveSession &&
      await openSessionReason(this.prisma, node.endpointId, facts.rustdeskSessions, now, true));
    const hold = policyHold(p, now, { sessionOpen, loggedOnUser: facts.loggedOnUser });
    if ((node.updateHoldReason ?? null) !== hold) {
      await this.prisma.rustdeskNode.update({
        where: { id: node.id },
        data: { updateHoldReason: hold, updateHoldAt: hold ? now : null },
      }).catch((e) => this.logger.warn(`could not record hold reason for ${node.endpointId}: ${String(e)}`));
    }
    return hold;
  }
}
