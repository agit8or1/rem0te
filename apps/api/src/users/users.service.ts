import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Numeric priority — actors can only modify users at strictly lower priority.
const ROLE_PRIORITY: Record<RoleType, number> = {
  PLATFORM_ADMIN: 100,
  TENANT_OWNER:   90,
  TENANT_ADMIN:   80,
  BILLING_ADMIN:  60,
  TECHNICIAN:     50,
  READ_ONLY:      40,
  CUSTOMER:       10,
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────────

  async listMembers(tenantId: string) {
    return this.prisma.membership.findMany({
      where: { tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            createdAt: true,
            mfaMethods: {
              where: { type: 'TOTP', isActive: true },
              select: { id: true },
            },
          },
        },
        role: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Invite ──────────────────────────────────────────────────────────────────

  async invite(tenantId: string, actorId: string, email: string, roleId: string) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found in this tenant`);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      const membership = await this.prisma.membership.findFirst({
        where: { userId: existing.id, tenantId },
      });
      if (membership) throw new BadRequestException('User is already a member of this tenant');
    }

    let userId: string;
    if (!existing) {
      const newUser = await this.prisma.user.create({
        data: {
          email,
          firstName: '',
          lastName: '',
          passwordHash: '',
          status: 'INVITED',
        },
      });
      userId = newUser.id;
    } else {
      userId = existing.id;
    }

    const inviteToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    await this.prisma.invitation.create({
      data: { tenantId, invitedById: actorId, email, roleId, token: inviteToken, expiresAt },
    });

    const membership = await this.prisma.membership.create({
      data: { tenantId, userId, roleId, isActive: false },
      include: {
        user: { select: { id: true, email: true } },
        role: { select: { id: true, name: true, type: true } },
      },
    });

    await this.audit.log({
      tenantId, actorId,
      action: 'USER_INVITED',
      resource: 'membership',
      resourceId: membership.id,
      meta: { email, roleId, roleName: role.name },
    });

    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    return { membership, inviteToken, inviteUrl: `${appUrl}/accept-invite?token=${inviteToken}` };
  }

  // ── Update profile ──────────────────────────────────────────────────────────

  async updateProfile(
    tenantId: string,
    userId: string,
    actorId: string,
    actorRoleType: RoleType | null,
    data: { firstName?: string; lastName?: string; email?: string },
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { user: true, role: true },
    });
    if (!membership) throw new NotFoundException('User not found in this tenant');

    // Non-platform-admins can only edit users at strictly lower role priority
    if (actorRoleType && actorId !== userId) {
      const actorPriority = ROLE_PRIORITY[actorRoleType] ?? 0;
      const targetPriority = ROLE_PRIORITY[membership.role.type] ?? 0;
      if (targetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot edit a user with equal or higher role');
      }
    }

    // Email uniqueness check
    if (data.email && data.email !== membership.user.email) {
      const clash = await this.prisma.user.findUnique({ where: { email: data.email } });
      if (clash) throw new BadRequestException('Email already in use');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName  !== undefined && { lastName:  data.lastName  }),
        ...(data.email     !== undefined && { email:     data.email.toLowerCase() }),
      },
      select: { id: true, email: true, firstName: true, lastName: true, status: true },
    });

    await this.audit.log({
      tenantId, actorId,
      action: 'USER_UPDATED',
      resource: 'user',
      resourceId: userId,
      meta: { fields: Object.keys(data) },
    });

    return updated;
  }

  // ── Reset password (admin-initiated) ────────────────────────────────────────

  async resetPassword(
    tenantId: string,
    userId: string,
    actorId: string,
    actorRoleType: RoleType | null,
    newPassword: string,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { role: true },
    });
    if (!membership) throw new NotFoundException('User not found in this tenant');

    // Prevent resetting password of equal/higher role
    if (actorRoleType && actorId !== userId) {
      const actorPriority  = ROLE_PRIORITY[actorRoleType] ?? 0;
      const targetPriority = ROLE_PRIORITY[membership.role.type] ?? 0;
      if (targetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot reset password of a user with equal or higher role');
      }
    }

    if (!newPassword || newPassword.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters');
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, status: 'ACTIVE' },
    });

    await this.audit.log({
      tenantId, actorId,
      action: 'PASSWORD_CHANGED',
      resource: 'user',
      resourceId: userId,
      meta: { adminReset: true },
    });

    return { success: true };
  }

  // ── Suspend / Activate ──────────────────────────────────────────────────────

  async suspend(
    tenantId: string,
    userId: string,
    actorId: string,
    actorRoleType: RoleType | null,
  ) {
    if (actorId === userId) throw new ForbiddenException('Cannot suspend your own account');

    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { user: true, role: true },
    });
    if (!membership) throw new NotFoundException(`User ${userId} not found in this tenant`);

    if (actorRoleType) {
      const actorPriority  = ROLE_PRIORITY[actorRoleType] ?? 0;
      const targetPriority = ROLE_PRIORITY[membership.role.type] ?? 0;
      if (targetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot suspend a user with equal or higher role');
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });

    await this.audit.log({
      tenantId, actorId,
      action: 'USER_SUSPENDED',
      resource: 'user',
      resourceId: userId,
      meta: { email: membership.user.email },
    });

    return { success: true };
  }

  async activate(
    tenantId: string,
    userId: string,
    actorId: string,
    actorRoleType: RoleType | null,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { user: true, role: true },
    });
    if (!membership) throw new NotFoundException(`User ${userId} not found in this tenant`);

    if (actorRoleType && actorId !== userId) {
      const actorPriority  = ROLE_PRIORITY[actorRoleType] ?? 0;
      const targetPriority = ROLE_PRIORITY[membership.role.type] ?? 0;
      if (targetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot activate a user with equal or higher role');
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });

    await this.audit.log({
      tenantId, actorId,
      action: 'USER_UPDATED',
      resource: 'user',
      resourceId: userId,
      meta: { email: membership.user.email, action: 'activated' },
    });

    return { success: true };
  }

  // ── Change role ──────────────────────────────────────────────────────────────

  async changeRole(
    tenantId: string,
    userId: string,
    roleId: string,
    actorId: string,
    actorRoleType: RoleType | null,
  ) {
    if (actorId === userId) throw new ForbiddenException('Cannot change your own role');

    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { role: true },
    });
    if (!membership) throw new NotFoundException(`User ${userId} not found in this tenant`);

    const targetRole = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!targetRole) throw new NotFoundException(`Role ${roleId} not found in this tenant`);

    if (actorRoleType) {
      const actorPriority       = ROLE_PRIORITY[actorRoleType] ?? 0;
      const currentTargetPri    = ROLE_PRIORITY[membership.role.type] ?? 0;
      const newTargetPriority   = ROLE_PRIORITY[targetRole.type] ?? 0;
      // Can't change a user whose current role is ≥ actor's role
      if (currentTargetPri >= actorPriority) {
        throw new ForbiddenException('Cannot change the role of a user with equal or higher role');
      }
      // Can't assign a role ≥ actor's own role (prevents privilege escalation)
      if (newTargetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot assign a role equal to or higher than your own');
      }
    }

    const updated = await this.prisma.membership.update({
      where: { id: membership.id },
      data: { roleId },
      include: {
        user: { select: { id: true, email: true } },
        role: { select: { id: true, name: true, type: true } },
      },
    });

    await this.audit.log({
      tenantId, actorId,
      action: 'ROLE_CHANGED',
      resource: 'membership',
      resourceId: membership.id,
      meta: { userId, roleId, roleName: targetRole.name },
    });

    return updated;
  }

  // ── Remove from tenant ──────────────────────────────────────────────────────

  async removeFromTenant(
    tenantId: string,
    userId: string,
    actorId: string,
    actorRoleType: RoleType | null,
  ) {
    if (actorId === userId) throw new ForbiddenException('Cannot remove yourself from the tenant');

    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { user: true, role: true },
    });
    if (!membership) throw new NotFoundException('User not found in this tenant');

    if (actorRoleType) {
      const actorPriority  = ROLE_PRIORITY[actorRoleType] ?? 0;
      const targetPriority = ROLE_PRIORITY[membership.role.type] ?? 0;
      if (targetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot remove a user with equal or higher role');
      }
    }

    await this.prisma.membership.delete({ where: { id: membership.id } });

    // If user has no remaining memberships, mark them DELETED
    const remaining = await this.prisma.membership.count({ where: { userId } });
    if (remaining === 0) {
      await this.prisma.user.update({ where: { id: userId }, data: { status: 'DELETED' } });
    }

    await this.audit.log({
      tenantId, actorId,
      action: 'USER_DELETED',
      resource: 'membership',
      resourceId: membership.id,
      meta: { email: membership.user.email },
    });

    return { success: true };
  }

  // ── Reset MFA ───────────────────────────────────────────────────────────────

  async resetMfa(
    tenantId: string,
    userId: string,
    actorId: string,
    actorRoleType: RoleType | null,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId },
      include: { user: true, role: true },
    });
    if (!membership) throw new NotFoundException('User not found in this tenant');

    if (actorRoleType && actorId !== userId) {
      const actorPriority  = ROLE_PRIORITY[actorRoleType] ?? 0;
      const targetPriority = ROLE_PRIORITY[membership.role.type] ?? 0;
      if (targetPriority >= actorPriority) {
        throw new ForbiddenException('Cannot reset MFA of a user with equal or higher role');
      }
    }

    await this.prisma.userMfaMethod.updateMany({
      where: { userId, type: 'TOTP' },
      data: { isActive: false },
    });

    await this.audit.log({
      tenantId, actorId,
      action: 'MFA_RESET',
      resource: 'user',
      resourceId: userId,
      meta: { email: membership.user.email, adminReset: true },
    });

    return { success: true };
  }

  // ── Platform admin management ────────────────────────────────────────────────

  async listPlatformAdmins() {
    return this.prisma.user.findMany({
      where: { isPlatformAdmin: true },
      select: { id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async setPlatformAdmin(targetUserId: string, enabled: boolean, actorId: string) {
    if (actorId === targetUserId && !enabled) {
      throw new ForbiddenException('Cannot revoke your own platform admin privileges');
    }

    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isPlatformAdmin: enabled },
      select: { id: true, email: true, firstName: true, lastName: true, isPlatformAdmin: true },
    });

    await this.audit.log({
      actorId,
      action: 'USER_UPDATED',
      resource: 'user',
      resourceId: targetUserId,
      meta: { setPlatformAdmin: enabled, email: user.email },
    });

    return updated;
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, firstName: true, lastName: true, status: true, isPlatformAdmin: true },
    });
  }

  // ── MFA status ──────────────────────────────────────────────────────────────

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
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    return {
      mfaEnabled: user.mfaMethods.length > 0,
      enrolledAt: user.mfaMethods[0]?.createdAt ?? null,
    };
  }
}
