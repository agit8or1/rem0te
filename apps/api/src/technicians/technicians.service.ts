import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, isOwnerRole, sanitizeTechnicianCapabilities, TECHNICIAN_ASSIGNABLE_CAPABILITIES } from '../rbac/capabilities';
import { PLATFORM_PERM, sanitizePlatformPermissions } from '../rbac/platform-permissions';
import { TechnicianAccessService } from '../rbac/technician-access.service';
import { parseSchedule } from '../rbac/schedule';

export interface AssignmentInput {
  userId?: string;
  groupId?: string;
  businessId: string;
  capabilities?: string[];
  endpointIds?: string[];
  startsAt?: string | null;
  expiresAt?: string | null;
  schedule?: unknown;
  reason?: string;
}

/**
 * Technician assignments and groups.
 *
 * Who may do what:
 *   create / revoke assignments, manage groups   `technicians:manage` (or Platform Admin)
 *   grant `technicians:manage` itself            Platform Admin only
 *   request access to a business                 any current technician (has a grant or a group)
 *   approve / deny a pending assignment          that business's Business Owner (or Platform Admin)
 *   require approval for a business              that business's Business Owner (or Platform Admin)
 *
 * A Business Owner can never create an assignment: that would be one business
 * handing out access to itself to someone outside it with no MSP-side
 * accountability, and from there the next step is handing it out to another
 * business. Approval is the only part they play, and only for their own.
 */
@Injectable()
export class TechniciansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly access: TechnicianAccessService,
  ) {}

  // ── Self ──────────────────────────────────────────────────────────────────

  /** My technician access: what is active, why, and what exists but does not count now. */
  async mine(actor: ActorContext) {
    const { scopes, inactive } = await this.access.resolve(actor.userId);
    return {
      activeBusinessId: actor.technician?.businessId ?? actor.businessId,
      ownBusinessId: actor.ownBusinessId ?? null,
      businesses: [...scopes.values()].sort((a, b) => a.businessName.localeCompare(b.businessName)),
      inactive,
    };
  }

  /**
   * "All assigned businesses": a read-only overview across every business the
   * technician can reach right now. Each business is queried with ITS OWN
   * scope (its capabilities, its computer list) — nothing from one grant ever
   * widens what is shown for another business.
   */
  async overview(actor: ActorContext) {
    const { scopes } = await this.access.resolve(actor.userId);
    const out = [];
    for (const s of [...scopes.values()].sort((a, b) => a.businessName.localeCompare(b.businessName))) {
      const caps = new Set<string>(s.capabilities);
      const endpointWhere: Prisma.EndpointWhereInput = {
        customerId: s.businessId, status: 'ACTIVE',
        ...(s.endpointIds ? { id: { in: s.endpointIds } } : {}),
      };
      const sessionWhere: Prisma.SupportSessionWhereInput = {
        customerId: s.businessId,
        ...(caps.has(CAP.HISTORY_VIEW) ? {} : { technicianId: actor.userId }),
        ...(s.endpointIds ? { OR: [{ endpointId: { in: s.endpointIds } }, { endpointId: null, technicianId: actor.userId }] } : {}),
      };
      const [computers, online, openSessions, waitingRequests, recentSessions] = await Promise.all([
        caps.has(CAP.COMPUTERS_VIEW) ? this.prisma.endpoint.count({ where: endpointWhere }) : null,
        caps.has(CAP.COMPUTERS_VIEW) ? this.prisma.endpoint.count({ where: { ...endpointWhere, isOnline: true } }) : null,
        caps.has(CAP.SESSIONS_VIEW)
          ? this.prisma.supportSession.count({
              where: { ...sessionWhere, status: { in: ['LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED', 'SESSION_STARTED'] } },
            })
          : null,
        caps.has(CAP.SUPPORT_REQUESTS)
          ? this.prisma.supportRequest.count({ where: { customerId: s.businessId, status: { in: ['WAITING', 'CLAIMED', 'CONNECTING'] } } })
          : null,
        caps.has(CAP.SESSIONS_VIEW)
          ? this.prisma.supportSession.findMany({
              where: sessionWhere, orderBy: { createdAt: 'desc' }, take: 5,
              select: {
                id: true, status: true, createdAt: true, timingQuality: true, connectionConfirmedAt: true,
                endpoint: { select: { id: true, name: true } },
                technician: { select: { id: true, firstName: true, lastName: true } },
              },
            })
          : [],
      ]);
      out.push({
        businessId: s.businessId,
        businessName: s.businessName,
        capabilities: s.capabilities,
        computerScope: s.endpointIds ? `${s.endpointIds.length} selected computer(s)` : 'All computers',
        sources: s.sources,
        computers, online, openSessions, waitingRequests, recentSessions,
      });
    }
    return out;
  }

  // ── Management ────────────────────────────────────────────────────────────

  private assertManager(actor: ActorContext) {
    this.acl.assertPlatformPermission(actor, PLATFORM_PERM.TECHNICIANS_MANAGE);
    // Acting *as* a technician in some business while managing technicians
    // would blur whose authority an assignment was created under.
    if (actor.technician) {
      throw new ForbiddenException('Switch back to your own account context to manage technician access');
    }
  }

  private parseDates(input: { startsAt?: string | null; expiresAt?: string | null }) {
    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (startsAt && isNaN(startsAt.getTime())) throw new BadRequestException('startsAt is not a valid date');
    if (expiresAt && isNaN(expiresAt.getTime())) throw new BadRequestException('expiresAt is not a valid date');
    if (startsAt && expiresAt && expiresAt <= startsAt) throw new BadRequestException('expiresAt must be after startsAt');
    return { startsAt, expiresAt };
  }

  private parseScheduleOr400(input: unknown) {
    try {
      return parseSchedule(input);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Validate that every listed computer belongs to the business. */
  private async assertEndpointsInBusiness(businessId: string, endpointIds: string[]) {
    if (endpointIds.length === 0) return;
    const n = await this.prisma.endpoint.count({ where: { id: { in: endpointIds }, customerId: businessId } });
    if (n !== new Set(endpointIds).size) {
      throw new BadRequestException('Every selected computer must belong to the selected business');
    }
  }

  async listAssignments(actor: ActorContext, filter: { userId?: string; groupId?: string; businessId?: string; includeRevoked?: boolean }) {
    this.assertManager(actor);
    return this.prisma.technicianAssignment.findMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.groupId ? { groupId: filter.groupId } : {}),
        ...(filter.businessId ? { customerId: filter.businessId } : {}),
        ...(filter.includeRevoked ? {} : { revokedAt: null }),
      },
      include: {
        customer: { select: { id: true, name: true, technicianApprovalRequired: true } },
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async createAssignment(actor: ActorContext, input: AssignmentInput, opts: { selfRequest?: boolean } = {}) {
    if (!opts.selfRequest) this.assertManager(actor);
    if (!!input.userId === !!input.groupId) throw new BadRequestException('Assign to exactly one of a user or a group');

    const business = await this.prisma.customer.findUnique({
      where: { id: input.businessId },
      select: { id: true, tenantId: true, name: true, isActive: true, isArchived: true, technicianApprovalRequired: true },
    });
    if (!business || business.isArchived) throw new NotFoundException('Business not found');

    if (input.userId) {
      const u = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true, isPlatformAdmin: true } });
      if (!u || u.status === 'DELETED') throw new NotFoundException('User not found');
      if (u.isPlatformAdmin) throw new BadRequestException('Platform Admins already reach every business; they do not need assignments');
    }
    let groupCaps: string[] = [];
    if (input.groupId) {
      const g = await this.prisma.technicianGroup.findUnique({ where: { id: input.groupId }, select: { id: true, capabilities: true } });
      if (!g) throw new NotFoundException('Group not found');
      groupCaps = g.capabilities;
    }

    // A group assignment with no capabilities of its own takes a SNAPSHOT of
    // the group's defaults. Editing the group later must not silently widen
    // assignments that were created (or approved) under the old set.
    const explicit = sanitizeTechnicianCapabilities(input.capabilities ?? []);
    const capabilities = explicit.length > 0 ? explicit : sanitizeTechnicianCapabilities(groupCaps);
    if (capabilities.length === 0) {
      throw new BadRequestException(
        `Choose at least one capability. Assignable: ${TECHNICIAN_ASSIGNABLE_CAPABILITIES.join(', ')}`,
      );
    }
    const endpointIds = [...new Set((input.endpointIds ?? []).filter((x) => typeof x === 'string'))];
    await this.assertEndpointsInBusiness(business.id, endpointIds);
    const { startsAt, expiresAt } = this.parseDates(input);
    const schedule = this.parseScheduleOr400(input.schedule);

    const needsApproval = opts.selfRequest || business.technicianApprovalRequired;
    const row = await this.prisma.technicianAssignment.create({
      data: {
        tenantId: business.tenantId,
        customerId: business.id,
        userId: input.userId ?? null,
        groupId: input.groupId ?? null,
        capabilities,
        endpointIds,
        startsAt, expiresAt,
        schedule: schedule ? (schedule as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        reason: input.reason?.slice(0, 500) ?? null,
        approvalStatus: needsApproval ? 'PENDING' : 'NOT_REQUIRED',
        requestedById: opts.selfRequest ? actor.userId : null,
        createdById: actor.userId,
      },
    });
    await this.audit.log({
      tenantId: business.tenantId, customerId: business.id,
      actorId: actor.userId, actorIp: actor.ip,
      action: opts.selfRequest ? 'TECHNICIAN_ASSIGNMENT_REQUESTED' : 'TECHNICIAN_ASSIGNMENT_CREATED',
      resource: 'technician_assignment', resourceId: row.id,
      meta: {
        userId: row.userId, groupId: row.groupId, capabilities, endpointCount: endpointIds.length,
        startsAt, expiresAt, scheduled: !!schedule, approval: row.approvalStatus,
      },
    });
    return row;
  }

  async revokeAssignment(actor: ActorContext, id: string, reason?: string) {
    const a = await this.prisma.technicianAssignment.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Assignment not found');
    // A technician may withdraw their own pending request.
    const ownPending = a.requestedById === actor.userId && a.approvalStatus === 'PENDING';
    if (!ownPending) this.assertManager(actor);
    if (a.revokedAt) return a;
    const updated = await this.prisma.technicianAssignment.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById: actor.userId, revokeReason: reason?.slice(0, 500) ?? null },
    });
    // Unredeemed launcher tokens of the affected people are useless now
    // anyway (redemption re-authorizes), but revoke them so nothing is even
    // attempted with them.
    const userIds = a.userId
      ? [a.userId]
      : (await this.prisma.technicianGroupMember.findMany({ where: { groupId: a.groupId! }, select: { userId: true } })).map((m) => m.userId);
    await this.prisma.launcherToken.updateMany({
      where: { userId: { in: userIds }, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      tenantId: a.tenantId, customerId: a.customerId, actorId: actor.userId, actorIp: actor.ip,
      action: 'TECHNICIAN_ASSIGNMENT_REVOKED', resource: 'technician_assignment', resourceId: id,
      meta: { userId: a.userId, groupId: a.groupId, reason: reason ?? null },
    });
    return updated;
  }

  // ── Self-service access requests and approval (Feature 6) ─────────────────

  async requestAccess(actor: ActorContext, input: Omit<AssignmentInput, 'userId' | 'groupId'>) {
    // Allowed in a technician context too: a self-request uses nothing from
    // the business the caller is acting in (only their own user id), and a
    // technician whose single assignment is picked automatically has no
    // other context to switch to.
    // Only people the MSP already recognises as technicians may ask, so a
    // customer's own staff cannot use this to knock on other businesses' doors.
    const recognised = await this.prisma.technicianGroupMember.count({ where: { userId: actor.userId } })
      + await this.prisma.technicianAssignment.count({ where: { userId: actor.userId } });
    if (recognised === 0 && !this.acl.hasPlatformPermission(actor, PLATFORM_PERM.TECHNICIANS_MANAGE)) {
      throw new ForbiddenException('Only MSP technicians can request access to a business');
    }
    if (!input.expiresAt) throw new BadRequestException('An access request must have an end time');
    return this.createAssignment(actor, { ...input, userId: actor.userId }, { selfRequest: true });
  }

  /** Pending assignments the caller may decide. */
  async pendingApprovals(actor: ActorContext) {
    const where: Prisma.TechnicianAssignmentWhereInput = { approvalStatus: 'PENDING', revokedAt: null };
    if (!actor.isPlatformAdmin) {
      if (actor.technician || !isOwnerRole(actor.roleType) || !actor.businessId) return [];
      where.customerId = actor.businessId;
    }
    return this.prisma.technicianAssignment.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Approve or deny. The approver may NARROW (fewer capabilities, fewer
   * computers, an earlier end) but never widen: approval must not create
   * authority beyond what was asked for, and the approver's own scope is
   * their one business, which is all a request can name.
   */
  async decide(
    actor: ActorContext, id: string,
    input: { decision: 'APPROVE' | 'DENY'; note?: string; capabilities?: string[]; endpointIds?: string[]; expiresAt?: string | null },
  ) {
    const a = await this.prisma.technicianAssignment.findUnique({ where: { id } });
    if (!a || a.revokedAt) throw new NotFoundException('Request not found');
    if (!actor.isPlatformAdmin) {
      if (actor.technician || !isOwnerRole(actor.roleType) || actor.businessId !== a.customerId) {
        throw new NotFoundException('Request not found');
      }
    }
    if (a.approvalStatus !== 'PENDING') throw new ConflictException(`This request was already ${a.approvalStatus.toLowerCase()}`);
    // The requester cannot approve their own request, whatever else they hold.
    if (a.requestedById === actor.userId || (a.userId && a.userId === actor.userId)) {
      throw new ForbiddenException('You cannot approve access for yourself');
    }

    const data: Prisma.TechnicianAssignmentUpdateInput = {
      approvalStatus: input.decision === 'APPROVE' ? 'APPROVED' : 'DENIED',
      decidedById: actor.userId, decidedAt: new Date(), decisionNote: input.note?.slice(0, 500) ?? null,
    };
    if (input.decision === 'APPROVE') {
      if (input.capabilities) {
        const narrowed = sanitizeTechnicianCapabilities(input.capabilities);
        const base = a.capabilities;
        if (base.length > 0 && narrowed.some((c) => !base.includes(c))) {
          throw new BadRequestException('Approval can only remove capabilities from a request, not add them');
        }
        if (narrowed.length === 0) throw new BadRequestException('Approving with no capabilities grants nothing; deny instead');
        data.capabilities = narrowed;
      }
      if (input.endpointIds) {
        const narrowed = [...new Set(input.endpointIds)];
        if (a.endpointIds.length > 0 && narrowed.some((e) => !a.endpointIds.includes(e))) {
          throw new BadRequestException('Approval can only remove computers from a request, not add them');
        }
        if (a.endpointIds.length === 0 && narrowed.length === 0) { /* whole business, as requested */ } else {
          await this.assertEndpointsInBusiness(a.customerId, narrowed);
          data.endpointIds = narrowed;
        }
      }
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        const e = new Date(input.expiresAt);
        if (isNaN(e.getTime())) throw new BadRequestException('expiresAt is not a valid date');
        if (a.expiresAt && e > a.expiresAt) throw new BadRequestException('Approval can only shorten the requested window');
        data.expiresAt = e;
      }
    }
    // Conditional on still being PENDING: two approvers clicking at once
    // cannot both decide.
    const res = await this.prisma.technicianAssignment.updateMany({
      where: { id, approvalStatus: 'PENDING' },
      data: data as Prisma.TechnicianAssignmentUpdateManyMutationInput,
    });
    if (res.count === 0) throw new ConflictException('This request was decided by someone else just now');
    await this.audit.log({
      tenantId: a.tenantId, customerId: a.customerId, actorId: actor.userId, actorIp: actor.ip,
      action: input.decision === 'APPROVE' ? 'TECHNICIAN_ASSIGNMENT_APPROVED' : 'TECHNICIAN_ASSIGNMENT_DENIED',
      resource: 'technician_assignment', resourceId: id,
      meta: { userId: a.userId, groupId: a.groupId, note: input.note ?? null },
    });
    return this.prisma.technicianAssignment.findUnique({ where: { id } });
  }

  async setApprovalRequired(actor: ActorContext, businessId: string, required: boolean) {
    if (!actor.isPlatformAdmin) {
      if (actor.technician || !isOwnerRole(actor.roleType) || actor.businessId !== businessId) {
        throw new ForbiddenException('Only this business\'s Business Owner can change that');
      }
    }
    const b = await this.prisma.customer.update({
      where: { id: businessId }, data: { technicianApprovalRequired: required },
      select: { id: true, tenantId: true, technicianApprovalRequired: true },
    });
    await this.audit.log({
      tenantId: b.tenantId, customerId: b.id, actorId: actor.userId, actorIp: actor.ip,
      action: 'BUSINESS_UPDATED', resource: 'business', resourceId: b.id,
      meta: { technicianApprovalRequired: required },
    });
    return b;
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async listGroups(actor: ActorContext) {
    this.assertManager(actor);
    return this.prisma.technicianGroup.findMany({
      include: {
        members: { include: { user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } } } },
        assignments: {
          where: { revokedAt: null },
          include: { customer: { select: { id: true, name: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  private async tenantId(): Promise<string> {
    const t = await this.prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!t) throw new BadRequestException('No platform container');
    return t.id;
  }

  async createGroup(actor: ActorContext, input: { name: string; description?: string; capabilities?: string[] }) {
    this.assertManager(actor);
    const g = await this.prisma.technicianGroup.create({
      data: {
        tenantId: await this.tenantId(),
        name: input.name.trim().slice(0, 100),
        description: input.description?.slice(0, 500) ?? null,
        capabilities: sanitizeTechnicianCapabilities(input.capabilities ?? []),
        createdById: actor.userId,
      },
    });
    await this.audit.log({
      tenantId: g.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'TECHNICIAN_GROUP_CREATED', resource: 'technician_group', resourceId: g.id,
      meta: { name: g.name, capabilities: g.capabilities },
    });
    return g;
  }

  async updateGroup(actor: ActorContext, id: string, input: { name?: string; description?: string; capabilities?: string[] }) {
    this.assertManager(actor);
    const g = await this.prisma.technicianGroup.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim().slice(0, 100) } : {}),
        ...(input.description !== undefined ? { description: input.description?.slice(0, 500) ?? null } : {}),
        ...(input.capabilities ? { capabilities: sanitizeTechnicianCapabilities(input.capabilities) } : {}),
      },
    });
    await this.audit.log({
      tenantId: g.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'TECHNICIAN_GROUP_UPDATED', resource: 'technician_group', resourceId: g.id,
      meta: { name: g.name, capabilities: g.capabilities },
    });
    return g;
  }

  async deleteGroup(actor: ActorContext, id: string) {
    this.assertManager(actor);
    const g = await this.prisma.technicianGroup.delete({ where: { id } });
    await this.audit.log({
      tenantId: g.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'TECHNICIAN_GROUP_DELETED', resource: 'technician_group', resourceId: id, meta: { name: g.name },
    });
    return { deleted: true };
  }

  async addMember(actor: ActorContext, groupId: string, userId: string) {
    this.assertManager(actor);
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, isPlatformAdmin: true } });
    if (!u || u.status === 'DELETED') throw new NotFoundException('User not found');
    const m = await this.prisma.technicianGroupMember.upsert({
      where: { groupId_userId: { groupId, userId } },
      update: {},
      create: { groupId, userId, addedById: actor.userId },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'TECHNICIAN_GROUP_MEMBER_ADDED', resource: 'technician_group', resourceId: groupId, meta: { userId },
    });
    return m;
  }

  async removeMember(actor: ActorContext, groupId: string, userId: string) {
    this.assertManager(actor);
    await this.prisma.technicianGroupMember.deleteMany({ where: { groupId, userId } });
    await this.prisma.launcherToken.updateMany({
      where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'TECHNICIAN_GROUP_MEMBER_REMOVED', resource: 'technician_group', resourceId: groupId, meta: { userId },
    });
    return { removed: true };
  }

  // ── People ────────────────────────────────────────────────────────────────

  /** Users a manager may assign, with their effective technician access. */
  async listTechnicians(actor: ActorContext) {
    this.assertManager(actor);
    const users = await this.prisma.user.findMany({
      where: { status: { in: ['ACTIVE', 'SUSPENDED'] }, isPlatformAdmin: false },
      select: {
        id: true, email: true, firstName: true, lastName: true, status: true, platformPermissions: true,
        memberships: { where: { isActive: true }, select: { customer: { select: { id: true, name: true } }, role: { select: { type: true } } } },
        technicianGroups: { select: { group: { select: { id: true, name: true } } } },
      },
      orderBy: { email: 'asc' },
      take: 1000,
    });
    return users.map((u) => ({
      id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, status: u.status,
      platformPermissions: u.platformPermissions,
      ownBusiness: u.memberships[0]?.customer ?? null,
      ownRole: u.memberships[0]?.role.type ?? null,
      groups: u.technicianGroups.map((g) => g.group),
    }));
  }

  async effectiveFor(actor: ActorContext, userId: string) {
    this.assertManager(actor);
    const { scopes, inactive } = await this.access.resolve(userId);
    return { businesses: [...scopes.values()], inactive };
  }

  /** Grant or remove platform permissions. Platform Admin only. */
  async setPlatformPermissions(actor: ActorContext, userId: string, perms: unknown) {
    this.acl.assertPlatformAdmin(actor);
    const clean = sanitizePlatformPermissions(perms);
    const before = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformPermissions: true } });
    if (!before) throw new NotFoundException('User not found');
    const u = await this.prisma.user.update({
      where: { id: userId }, data: { platformPermissions: clean },
      select: { id: true, platformPermissions: true },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'PLATFORM_PERMISSIONS_CHANGED', resource: 'user', resourceId: userId,
      meta: { before: before.platformPermissions, after: clean },
    });
    return u;
  }
}
