import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { accessLevelLabel, DEFAULT_BUSINESS_USER_CAPABILITIES, sanitizeCapabilities } from '../rbac/capabilities';

/**
 * People.
 *
 * There are only three levels, so there is no priority ladder any more —
 * "may I act on this person" is one question, answered by
 * AccessControlService.assertMayManage():
 *
 *   • a Platform Admin may act on anyone
 *   • a Business Owner may act on Business Users in their own business
 *   • nobody else may act on anyone
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Members of the caller's business; every business for a Platform Admin. */
  async listMembers(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);

    const rows = await this.prisma.membership.findMany({
      where: { ...(scope ? { customerId: scope } : {}) },
      include: {
        user: {
          select: {
            id: true, email: true, firstName: true, lastName: true,
            status: true, createdAt: true, isPlatformAdmin: true,
            phone: true, jobTitle: true,
            address: true, city: true, state: true, country: true, postalCode: true, timeZone: true,
            mfaMethods: { where: { type: 'TOTP', isActive: true }, select: { id: true } },
          },
        },
        role: { select: { id: true, name: true, type: true } },
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((m) => ({
      ...m,
      business: m.customer,
      accessLevel: accessLevelLabel({
        isPlatformAdmin: m.user.isPlatformAdmin,
        roleType: m.role.type,
      }),
      capabilities: m.capabilities,
    }));
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async updateProfile(
    actor: ActorContext,
    userId: string,
    data: {
      firstName?: string; lastName?: string; email?: string;
      phone?: string; jobTitle?: string;
      address?: string; city?: string; state?: string; country?: string; postalCode?: string;
      timeZone?: string;
    },
  ) {
    const membership = await this.acl.assertUserInScope(actor, userId);
    if (actor.userId !== userId) {
      this.acl.assertMayManage(actor, {
        roleType: membership.role.type,
        isPlatformAdmin: membership.user.isPlatformAdmin,
        userId,
      });
    }

    if (data.email) {
      const clash = await this.prisma.user.findFirst({
        where: { email: data.email.toLowerCase(), NOT: { id: userId } },
      });
      if (clash) throw new BadRequestException('Email already in use');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName  !== undefined && { firstName:  data.firstName }),
        ...(data.lastName   !== undefined && { lastName:   data.lastName  }),
        ...(data.email      !== undefined && { email:      data.email.toLowerCase() }),
        ...(data.phone      !== undefined && { phone:      data.phone || null }),
        ...(data.jobTitle   !== undefined && { jobTitle:   data.jobTitle || null }),
        ...(data.address    !== undefined && { address:    data.address || null }),
        ...(data.city       !== undefined && { city:       data.city || null }),
        ...(data.state      !== undefined && { state:      data.state || null }),
        ...(data.country    !== undefined && { country:    data.country || null }),
        ...(data.postalCode !== undefined && { postalCode: data.postalCode || null }),
        ...(data.timeZone   !== undefined && { timeZone:   data.timeZone || null }),
      },
      select: {
        id: true, email: true, firstName: true, lastName: true, status: true,
        phone: true, jobTitle: true,
        address: true, city: true, state: true, country: true, postalCode: true, timeZone: true,
      },
    });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_UPDATED', resource: 'user', resourceId: userId,
      meta: { fields: Object.keys(data) },
    });
    return updated;
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  async resetPassword(actor: ActorContext, userId: string, newPassword: string) {
    const membership = await this.acl.assertUserInScope(actor, userId);
    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId,
    });

    if (!newPassword || newPassword.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters');
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, status: 'ACTIVE' },
    });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'PASSWORD_CHANGED', resource: 'user', resourceId: userId,
      meta: { adminReset: true },
    });
    return { success: true };
  }

  async resetMfa(actor: ActorContext, userId: string) {
    const membership = await this.acl.assertUserInScope(actor, userId);
    if (actor.userId !== userId) {
      this.acl.assertMayManage(actor, {
        roleType: membership.role.type,
        isPlatformAdmin: membership.user.isPlatformAdmin,
        userId,
      });
    }

    await this.prisma.userMfaMethod.updateMany({
      where: { userId, type: 'TOTP' },
      data: { isActive: false },
    });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'MFA_RESET', resource: 'user', resourceId: userId,
      meta: { email: membership.user.email, adminReset: true },
    });
    return { success: true };
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async suspend(actor: ActorContext, userId: string) {
    if (actor.userId === userId) throw new ForbiddenException('You cannot suspend your own account');

    const membership = await this.acl.assertUserInScope(actor, userId);
    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId,
    });

    await this.prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    await this.prisma.membership.update({ where: { id: membership.id }, data: { isActive: false } });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_SUSPENDED', resource: 'user', resourceId: userId,
      meta: { email: membership.user.email },
    });
    return { success: true };
  }

  async activate(actor: ActorContext, userId: string) {
    const membership = await this.acl.assertUserInScope(actor, userId);
    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId,
    });

    await this.prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    await this.prisma.membership.update({ where: { id: membership.id }, data: { isActive: true } });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_UPDATED', resource: 'user', resourceId: userId,
      meta: { email: membership.user.email, action: 'activated' },
    });
    return { success: true };
  }

  // ── Level ─────────────────────────────────────────────────────────────────

  /**
   * Move someone between the two business levels.
   *
   * Only a Platform Admin can make someone a Business Owner — that is the
   * boundary a Business Owner must not be able to widen, in either direction,
   * for themselves or anyone else.
   */
  async setLevel(actor: ActorContext, userId: string, level: 'BUSINESS_OWNER' | 'BUSINESS_USER') {
    if (actor.userId === userId) throw new ForbiddenException('You cannot change your own access level');

    const membership = await this.acl.assertUserInScope(actor, userId);
    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId,
    });

    if (level === 'BUSINESS_OWNER' && !actor.isPlatformAdmin) {
      throw new ForbiddenException('Only a Platform Admin can promote someone to Business Owner');
    }

    const role = await this.prisma.role.findFirst({
      where: { tenantId: membership.tenantId, type: level as RoleType },
      select: { id: true, name: true, type: true },
    });
    if (!role) throw new BadRequestException(`System role ${level} is missing — re-run the seed`);

    const updated = await this.prisma.membership.update({
      where: { id: membership.id },
      data: {
        roleId: role.id,
        // An owner's capabilities are implicit; a demoted owner drops back to
        // the safe default rather than inheriting a blank (= no access) set.
        capabilities: level === 'BUSINESS_OWNER' ? [] : DEFAULT_BUSINESS_USER_CAPABILITIES,
      },
      include: {
        user: { select: { id: true, email: true } },
        role: { select: { id: true, name: true, type: true } },
      },
    });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ROLE_CHANGED', resource: 'membership', resourceId: membership.id,
      meta: { userId, from: membership.role.type, to: level },
    });
    return updated;
  }

  /** Set a Business User's capabilities. */
  async setCapabilities(actor: ActorContext, userId: string, capabilities: string[]) {
    if (actor.userId === userId) {
      throw new ForbiddenException('You cannot change your own permissions');
    }

    const membership = await this.acl.assertUserInScope(actor, userId);
    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId,
    });

    if (membership.role.type === RoleType.BUSINESS_OWNER) {
      throw new BadRequestException(
        'A Business Owner already holds every business permission — permissions apply to Business Users.',
      );
    }

    const clean = sanitizeCapabilities(capabilities);
    const updated = await this.prisma.membership.update({
      where: { id: membership.id },
      data: { capabilities: clean },
      select: { id: true, capabilities: true },
    });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_CAPABILITIES_UPDATED', resource: 'membership', resourceId: membership.id,
      meta: { userId, from: membership.capabilities, to: clean },
    });
    return updated;
  }

  /** Move someone into a different business. Platform Admin only. */
  async setBusiness(actor: ActorContext, userId: string, businessId: string | null) {
    this.acl.assertPlatformAdmin(actor);

    const membership = await this.prisma.membership.findFirst({
      where: { userId },
      select: { id: true, tenantId: true, customerId: true },
    });
    if (!membership) throw new NotFoundException('That user has no membership');

    if (businessId) {
      const business = await this.prisma.customer.findUnique({
        where: { id: businessId }, select: { id: true, tenantId: true },
      });
      if (!business) throw new NotFoundException('Business not found');
    }

    // Standing per-computer grants belong to the old business. Moving someone
    // without clearing them would carry access across the boundary.
    if (membership.customerId && membership.customerId !== businessId) {
      await this.prisma.computerAccess.deleteMany({
        where: { userId, endpoint: { customerId: membership.customerId } },
      });
    }

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { customerId: businessId },
    });

    await this.audit.log({
      tenantId: membership.tenantId, customerId: businessId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_UPDATED', resource: 'membership', resourceId: membership.id,
      meta: { userId, movedFrom: membership.customerId, movedTo: businessId },
    });
    return { success: true, businessId };
  }

  // ── Removal ───────────────────────────────────────────────────────────────

  async remove(actor: ActorContext, userId: string) {
    if (actor.userId === userId) throw new ForbiddenException('You cannot remove your own account');

    const membership = await this.acl.assertUserInScope(actor, userId);
    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId,
    });

    await this.prisma.computerAccess.deleteMany({ where: { userId } });
    await this.prisma.membership.delete({ where: { id: membership.id } });

    const remaining = await this.prisma.membership.count({ where: { userId } });
    if (remaining === 0 && !membership.user.isPlatformAdmin) {
      await this.prisma.user.update({ where: { id: userId }, data: { status: 'DELETED' } });
    }

    await this.audit.log({
      tenantId: membership.tenantId, customerId: membership.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_DELETED', resource: 'membership', resourceId: membership.id,
      meta: { email: membership.user.email },
    });
    return { success: true };
  }

  // ── Platform admins ───────────────────────────────────────────────────────

  async listPlatformAdmins(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return this.prisma.user.findMany({
      where: { isPlatformAdmin: true },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        status: true, createdAt: true,
        mfaMethods: { where: { type: 'TOTP', isActive: true }, select: { id: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async setPlatformAdmin(actor: ActorContext, targetUserId: string, enabled: boolean) {
    this.acl.assertPlatformAdmin(actor);

    if (actor.userId === targetUserId && !enabled) {
      throw new ForbiddenException('You cannot revoke your own Platform Admin access');
    }
    if (!enabled) {
      // Never leave the platform without an operator.
      const remaining = await this.prisma.user.count({
        where: { isPlatformAdmin: true, status: 'ACTIVE', NOT: { id: targetUserId } },
      });
      if (remaining === 0) {
        throw new BadRequestException('There must be at least one active Platform Admin');
      }
    }

    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isPlatformAdmin: enabled },
      select: { id: true, email: true, firstName: true, lastName: true, isPlatformAdmin: true },
    });

    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_UPDATED', resource: 'user', resourceId: targetUserId,
      meta: { setPlatformAdmin: enabled, email: user.email },
    });
    return updated;
  }

  /**
   * Look a person up by email so an admin can add an existing account rather
   * than creating a duplicate. Platform Admin only — for anyone else this
   * would be an oracle for which addresses have Rem0te accounts.
   */
  async findUserByEmail(actor: ActorContext, email: string) {
    this.acl.assertPlatformAdmin(actor);
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        status: true, isPlatformAdmin: true,
        memberships: { select: { customer: { select: { id: true, name: true } } } },
      },
    });
  }

  // ── Self ──────────────────────────────────────────────────────────────────

  async getMfaStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        mfaMethods: {
          where: { type: 'TOTP', isActive: true },
          select: { id: true, createdAt: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      mfaEnabled: user.mfaMethods.length > 0,
      enrolledAt: user.mfaMethods[0]?.createdAt ?? null,
    };
  }
}
