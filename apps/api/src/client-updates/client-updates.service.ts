import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ClientUpdatePolicy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ContainmentService } from '../containment/containment.service';
import { latestRustdeskVersion } from '../common/rustdesk-release';
import { openSessionReason } from '../admin/session-evidence';
import {
  BLOCKER, blocker, effectivePolicy, explainPolicy, HOLD_TEXT, policyHold, PolicyInput, policyScope, policyWindow, QUEUED_REASON_TEXT, reconcileQueued, resolvePolicy,
  ROLLOUT_OPEN, type HoldReason,
} from './policy';
import { GroupMembershipService, type Membership } from '../group-policy/membership.service';
import { describeWindow, parseUpdateWindow, windowState } from './update-window';

const ID = /^[A-Za-z0-9_-]{8,64}$/;

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
    private readonly groups: GroupMembershipService,
  ) {}

  /**
   * 0.35: device-group membership for this business's group policies, now —
   * for `within` computers, or the whole business. Never kept between calls.
   */
  async membershipFor(policies: Pick<ClientUpdatePolicy, 'groupId'>[], within?: string[]): Promise<Membership> {
    return this.groups.snapshot(policies.filter((p) => p.groupId).map((p) => p.groupId!), within);
  }

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
      id: p.id, siteId: p.siteId, groupId: p.groupId, priority: p.priority, enabled: p.enabled, timeZone: p.timeZone, windows: p.windows,
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
    const [policies, sites, groups, paused, target] = await Promise.all([
      this.prisma.clientUpdatePolicy.findMany({ where: { customerId } }),
      this.prisma.site.findMany({ where: { customerId }, select: { id: true, name: true, timezone: true }, orderBy: { name: 'asc' } }),
      this.prisma.endpointGroup.findMany({ where: { customerId }, select: { id: true, name: true, kind: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500 }),
      this.containment.blocking('updates', customerId),
      this.targetVersion(),
    ]);
    const refusal = this.editRefusal(a, customerId);
    // Members of the groups that carry a policy, among the computers THIS
    // person can see (never the raw total).
    const visibleIds = (await this.prisma.endpoint.findMany({ where: { AND: [this.visible(a, customerId), { status: { not: 'ARCHIVED' } }] }, select: { id: true }, take: 10_000 })).map((e) => e.id);
    const m = await this.membershipFor(policies, visibleIds);
    const gp = (id: string) => policies.find((p) => p.groupId === id) ?? null;
    return {
      business: { id: biz.id, name: biz.name },
      policy: this.view(policies.find((p) => p.siteId === null && p.groupId === null) ?? null, now),
      sites: sites.map((s) => ({ ...s, override: this.view(policies.find((p) => p.siteId === s.id) ?? null, now) })),
      // 0.35: device-group policies, most specific after a computer. Listed
      // in precedence order (priority, 1 first), then groups without one.
      groups: groups
        .map((g) => {
          const p = gp(g.id);
          const use = p ? m.groups.get(g.id)?.use ?? 'ok' : null;
          return { id: g.id, name: g.name, kind: g.kind === 'RULE' ? 'rule' : 'static', policy: this.view(p, now), members: p ? m.count(g.id) : null, use };
        })
        .sort((x, y) => (x.policy?.priority ?? Infinity) - (y.policy?.priority ?? Infinity) || (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0) || (x.id < y.id ? -1 : 1)),
      precedence: 'A group policy beats a site override, which beats the business policy. A computer in several groups with a policy follows the one with the lowest priority number (1 first); two group policies of a business never share a priority.',
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
    const membership = await this.membershipFor(policies, rows.map((r) => r.id));
    const siteName = new Map(rows.filter((r) => r.site).map((r) => [r.site!.id, r.site!.name]));
    const groupName = (id: string) => membership.groups.get(id)?.name ?? id;
    const byIds = [...new Set(rows.map((r) => r.rustdeskNode?.updateRequestedById).filter((x): x is string => !!x))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: byIds } }, select: { id: true, firstName: true, lastName: true, email: true } }))
      .map((u) => [u.id, { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email }]));

    // One window computation per policy, not per computer: it scans minutes.
    const states = new Map(policies.map((p) => [p.id, windowState(policyWindow(p), now)]));
    return {
      target,
      computers: rows.map((r) => {
        const n = r.rustdeskNode;
        const res = resolvePolicy(policies, { id: r.id, customerId, siteId: r.siteId, groupIds: membership.groupsOf(r.id) });
        const p = res.winner;
        const st = (p && states.get(p.id)) || { open: false, opensAt: null, closesAt: null };
        const policy = p ? {
          id: p.id, scope: policyScope(p), enabled: p.enabled, window: { open: st.open, opensAt: st.opensAt, closesAt: st.closesAt },
          group: p.groupId ? { id: p.groupId, name: groupName(p.groupId), priority: p.priority } : null,
          why: explainPolicy(res, { group: groupName, site: (id) => siteName.get(id) ?? id }),
          alsoIn: res.ranked.slice(1).filter((x) => x.scope === 'group').map((x) => ({ id: x.groupId!, name: groupName(x.groupId!), priority: x.priority })),
        } : null;
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
    return p ? { enabled: p.enabled, timeZone: p.timeZone, windows: p.windows, skipActiveSession: p.skipActiveSession, skipLoggedOnUser: p.skipLoggedOnUser, ...(p.groupId ? { priority: p.priority } : {}) } : null;
  }

  private priorityTaken(priority: number) {
    return new ConflictException({ code: 'PRIORITY_TAKEN', message: `Another device-group policy in this business already has priority ${priority}. Each needs its own, so a computer in both groups is decided by it.` });
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
    const groupId = input.groupId ?? null;
    if (siteId && groupId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A policy is for a site or for a device group, not both.' });
    if (siteId) await this.siteOf(customerId, siteId);
    // 0.35: another business's group is the same 404 as a made-up id.
    const group = groupId ? await this.groups.groupForPolicy(customerId, groupId) : null;
    const priority = input.priority ?? null;
    if (group && priority === null) throw new BadRequestException({ code: 'PRIORITY_REQUIRED', message: 'A device-group policy needs a priority (1 first): it decides between two groups a computer is in.' });
    if (!group && priority !== null) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only a device-group policy has a priority.' });
    if (group && await this.prisma.clientUpdatePolicy.findFirst({ where: { customerId, priority, groupId: { not: null, notIn: [group.id] } }, select: { id: true } })) throw this.priorityTaken(priority!);
    if (input.enabled && !fresh) throw new FreshAuthNeeded();
    const biz = await this.business(customerId);

    const data = {
      enabled: input.enabled, timeZone: window.timeZone, windows: window.windows as unknown as Prisma.InputJsonValue,
      skipActiveSession: input.skipActiveSession, skipLoggedOnUser: input.skipLoggedOnUser, updatedById: a.userId,
      ...(group ? { priority } : {}),
    };
    const before = await this.prisma.clientUpdatePolicy.findFirst({ where: group ? { customerId, groupId: group.id } : { customerId, siteId, groupId: null } });
    let after: ClientUpdatePolicy;
    try {
      after = before
        ? await this.prisma.clientUpdatePolicy.update({ where: { id: before.id }, data })
        : await this.prisma.clientUpdatePolicy.create({ data: { ...data, tenantId: biz.tenantId, customerId, siteId, groupId: group?.id ?? null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && group) throw this.priorityTaken(priority!);
      throw e;
    }
    const cleared = await this.clearUnwanted(customerId);

    await this.audit.log({
      tenantId: biz.tenantId, customerId, actorId: a.userId, actorIp: a.ip,
      action: 'CLIENT_UPDATE_POLICY_CHANGED', resource: 'client_update_policy', resourceId: after.id,
      meta: {
        scope: policyScope(after), siteId, ...(group ? { groupId: group.id, groupName: group.name } : {}), before: this.snapshot(before), after: this.snapshot(after),
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
   * 0.35: remove a device group's policy. Its computers fall back to their
   * site's or the business's policy, which may be on — so, like removing a
   * site override, this needs fresh authentication.
   */
  async deleteGroupPolicy(a: ActorContext, requested: string | null | undefined, groupId: string, fresh: boolean) {
    if (!ID.test(groupId)) throw new NotFoundException('Group not found');
    const customerId = this.scope(a, requested);
    this.assertEdit(a, customerId);
    const before = await this.prisma.clientUpdatePolicy.findFirst({ where: { customerId, groupId } });
    // Another business's group, a made-up id and a group with no policy here are one answer.
    if (!before) throw new NotFoundException('This group has no policy');
    if (!fresh) throw new FreshAuthNeeded();
    const biz = await this.business(customerId);
    await this.prisma.clientUpdatePolicy.delete({ where: { id: before.id } });
    const cleared = await this.clearUnwanted(customerId);
    await this.audit.log({
      tenantId: biz.tenantId, customerId, actorId: a.userId, actorIp: a.ip,
      action: 'CLIENT_UPDATE_POLICY_CHANGED', resource: 'client_update_policy', resourceId: before.id,
      meta: { scope: 'group', groupId, before: this.snapshot(before), after: null, removedGroupPolicy: true, clearedQueued: cleared, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { removed: true, clearedQueued: cleared };
  }

  /**
   * The effective policy for one computer, and why (0.35) — for the device
   * page. Needs computers:view on that computer: assertEndpointInScope, then
   * the visibility rule AND-ed with the id; anything else is a 404.
   */
  async endpointPolicy(a: ActorContext, endpointId: string) {
    if (!ID.test(endpointId)) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(a, endpointId, CAP.COMPUTERS_VIEW);
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [this.acl.endpointVisibilityWhere(a), { id: endpointId }] },
      select: { id: true, customerId: true, siteId: true, site: { select: { id: true, name: true } } },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    if (!ep.customerId) return { policy: null, considered: [], text: 'This computer is not in a business, so no update policy applies.' };
    const policies = await this.prisma.clientUpdatePolicy.findMany({ where: { customerId: ep.customerId } });
    const m = await this.membershipFor(policies, [ep.id]);
    const res = resolvePolicy(policies, { id: ep.id, customerId: ep.customerId, siteId: ep.siteId, groupIds: m.groupsOf(ep.id) });
    const now = new Date();
    const names = { group: (id: string) => m.groups.get(id)?.name ?? id, site: (id: string) => (ep.site?.id === id ? ep.site.name : id) };
    const label = (p: { scope: string; groupId?: string | null; siteId: string | null }) =>
      p.scope === 'group' ? { scope: 'group', group: { id: p.groupId!, name: names.group(p.groupId!) } } : p.scope === 'site' ? { scope: 'site', site: ep.site } : { scope: 'business' };
    return {
      policy: res.winner ? { ...this.view(res.winner, now), ...label(res.winner) } : null,
      considered: res.ranked.map((p) => ({ id: p.id, ...label(p), priority: p.priority ?? null, enabled: p.enabled, outcome: p.outcome.reason })),
      text: res.winner ? explainPolicy(res, names) : 'No update policy applies: it updates only when someone clicks Update.',
    };
  }

  /**
   * POLICY requests in this business whose computer is no longer governed by
   * an enabled policy are withdrawn: turning a policy off must stop what it
   * queued, not leave it waiting for a window that is no longer meant to
   * install anything. MANUAL requests are never touched here. Run on every
   * policy save (attributed to that change, counted in its audit entry).
   */
  private async clearUnwanted(customerId: string): Promise<number> {
    return (await this.reconcileQueued({ customerId })).withdrawn;
  }

  /**
   * Re-resolve every queued POLICY request (0.36) — in one business, or in
   * all of them — against the policies and device-group membership of NOW,
   * and withdraw or re-plan the ones whose policy no longer governs their
   * computer (policy.ts, reconcileQueued). The client-update sweep calls it
   * every tick, so a computer that leaves a group stops waiting on that
   * group's policy within one sweep, not at the next policy save.
   *
   * `audit` (the sweep) records each withdrawal and re-plan per computer, with
   * the reason; a policy save records only its count, in the save's own entry.
   * Each write is conditional on the request being the one that was read, so a
   * heartbeat handing it out at the same moment is never overwritten.
   */
  async reconcileQueued(o: { customerId?: string; audit?: boolean } = {}) {
    const out = { withdrawn: 0, replanned: 0, adopted: 0 };
    const queued = await this.prisma.rustdeskNode.findMany({
      where: { updateRequestSource: 'POLICY', updateRequestedAt: { not: null }, ...(o.customerId ? { endpoint: { customerId: o.customerId } } : {}) },
      select: {
        id: true, endpointId: true, updateRequestedAt: true, updatePolicyId: true, updateTargetVersion: true,
        endpoint: { select: { customerId: true, siteId: true, tenantId: true } },
      },
      orderBy: { id: 'asc' },
      take: 10_000,
    });
    const byBiz = new Map<string | null, typeof queued>();
    for (const n of queued) { const k = n.endpoint.customerId; const l = byBiz.get(k) ?? []; l.push(n); byBiz.set(k, l); }
    for (const [customerId, nodes] of byBiz) {
      const policies = customerId ? await this.prisma.clientUpdatePolicy.findMany({ where: { customerId } }) : [];
      const m = await this.membershipFor(policies, nodes.map((n) => n.endpointId));
      for (const n of nodes) {
        const eff = effectivePolicy(policies, customerId, n.endpoint.siteId, m.groupsOf(n.endpointId));
        const d = reconcileQueued(n.updatePolicyId ?? null, eff, policies);
        if (d.action === 'keep') continue;
        const same = { id: n.id, updateRequestSource: 'POLICY' as const, updateRequestedAt: n.updateRequestedAt, updatePolicyId: n.updatePolicyId };
        const w = await this.prisma.rustdeskNode.updateMany({
          where: same,
          data: d.action === 'withdraw'
            ? { updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null, updateRequestedById: null, updateHoldReason: null, updateHoldAt: null, updatePolicyId: null }
            // A hold recorded under the old policy says nothing about the new one; the next heartbeat records its own.
            : { updatePolicyId: d.to, ...(d.action === 'replan' ? { updateHoldReason: null, updateHoldAt: null } : {}) },
        });
        if (w.count !== 1) continue;
        if (d.action === 'withdraw') out.withdrawn++; else if (d.action === 'replan') out.replanned++; else out.adopted++;
        if (!o.audit || d.action === 'adopt') continue;
        const to = d.to ? policies.find((p) => p.id === d.to) ?? null : null;
        await this.audit.log({
          tenantId: n.endpoint.tenantId ?? undefined, customerId: customerId ?? undefined,
          action: d.action === 'withdraw' ? 'CLIENT_UPDATE_AUTO_WITHDRAWN' : 'CLIENT_UPDATE_AUTO_REPLANNED',
          resource: 'endpoint', resourceId: n.endpointId,
          meta: {
            reason: d.reason, text: QUEUED_REASON_TEXT[d.reason!], fromPolicyId: d.from, toPolicyId: d.to,
            ...(to ? { toScope: policyScope(to), ...(to.groupId ? { toGroupId: to.groupId, toPriority: to.priority } : {}), ...(to.siteId ? { toSiteId: to.siteId } : {}) } : {}),
            targetVersion: n.updateTargetVersion, queuedAt: n.updateRequestedAt, by: 'client-update sweep',
          },
        });
      }
    }
    return out;
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
    const m = await this.membershipFor(policies, [node.endpointId]);
    const p = effectivePolicy(policies, ep?.customerId ?? null, ep?.siteId ?? null, m.groupsOf(node.endpointId));
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
