import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import {
  DEFAULT_BUSINESS_USER_CAPABILITIES,
  sanitizeCapabilities,
} from '../rbac/capabilities';

export interface CreateBusinessDto {
  name: string;
  code?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  notes?: string;
}

export interface UpdateBusinessDto extends Partial<CreateBusinessDto> {
  isActive?: boolean;
  quickConnectEnabled?: boolean;
}

/**
 * A Business is a customer organisation. The platform operator creates them;
 * everything inside one — users, computers, sessions, audit — belongs to it
 * and to nothing else.
 *
 * Every method takes an {@link ActorContext} and runs its scope through
 * {@link AccessControlService}. There is no code path here that trusts an id
 * arriving from the client.
 */
@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  /** The platform container every business hangs off. */
  private async platformTenantId(actor: ActorContext): Promise<string> {
    if (actor.tenantId) return actor.tenantId;
    const t = await this.prisma.tenant.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!t) throw new BadRequestException('Platform is not initialised');
    return t.id;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async findAll(actor: ActorContext, search?: string, includeInactive = false) {
    const scope = this.acl.resolveScope(actor);

    return this.prisma.customer.findMany({
      where: {
        ...(scope ? { id: scope } : {}),
        isArchived: false,
        ...(includeInactive ? {} : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { city: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true, name: true, code: true, email: true, phone: true,
        address: true, city: true, state: true, country: true, postalCode: true,
        notes: true, isActive: true, quickConnectEnabled: true, createdAt: true,
        _count: { select: { endpoints: true, sites: true, portalUsers: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(actor: ActorContext, id: string) {
    await this.acl.assertBusinessInScope(actor, id);

    const business = await this.prisma.customer.findFirst({
      where: { id, isArchived: false },
      include: {
        sites: { where: { isActive: true } },
        endpoints: {
          where: { status: { not: 'ARCHIVED' } },
          include: { rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true } } },
          orderBy: [{ isOnline: 'desc' }, { name: 'asc' }],
        },
        _count: { select: { endpoints: true, sites: true, portalUsers: true } },
      },
    });
    if (!business) throw new NotFoundException('Business not found');
    return business;
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /** Creating a business is a platform-operator action. */
  async create(actor: ActorContext, dto: CreateBusinessDto) {
    this.acl.assertPlatformAdmin(actor);
    const tenantId = await this.platformTenantId(actor);

    const business = await this.prisma.customer.create({
      data: {
        tenantId,
        name: dto.name,
        code: dto.code ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        country: dto.country ?? null,
        postalCode: dto.postalCode ?? null,
        notes: dto.notes ?? null,
        isActive: true,
        isArchived: false,
      },
    });

    await this.audit.log({
      tenantId, customerId: business.id, actorId: actor.userId, actorIp: actor.ip,
      action: 'BUSINESS_CREATED', resource: 'business', resourceId: business.id,
      meta: { name: business.name },
    });

    return business;
  }

  /**
   * A Business Owner may edit their own business profile; only a Platform
   * Admin may enable/disable one or flip its Quick Connect switch.
   */
  async update(actor: ActorContext, id: string, dto: UpdateBusinessDto) {
    const existing = await this.acl.assertBusinessInScope(actor, id);

    if (dto.isActive !== undefined && !actor.isPlatformAdmin) {
      throw new BadRequestException('Only a Platform Admin can enable or disable a business');
    }
    if (dto.quickConnectEnabled !== undefined && !actor.isPlatformAdmin) {
      throw new BadRequestException('Only a Platform Admin can change the Quick Connect setting for a business');
    }
    if (!actor.isPlatformAdmin) this.acl.assertBusinessOwner(actor);

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.state !== undefined ? { state: dto.state } : {}),
        ...(dto.country !== undefined ? { country: dto.country } : {}),
        ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.quickConnectEnabled !== undefined ? { quickConnectEnabled: dto.quickConnectEnabled } : {}),
      },
    });

    if (dto.isActive === false) {
      await this.audit.log({
        tenantId: existing.tenantId, customerId: id, actorId: actor.userId, actorIp: actor.ip,
        action: 'BUSINESS_DISABLED', resource: 'business', resourceId: id,
      });
    }
    if (dto.quickConnectEnabled !== undefined) {
      await this.audit.log({
        tenantId: existing.tenantId, customerId: id, actorId: actor.userId, actorIp: actor.ip,
        action: 'QUICK_CONNECT_SETTING_CHANGED', resource: 'business', resourceId: id,
        meta: { scope: 'business', enabled: dto.quickConnectEnabled },
      });
    }
    await this.audit.log({
      tenantId: existing.tenantId, customerId: id, actorId: actor.userId, actorIp: actor.ip,
      action: 'BUSINESS_UPDATED', resource: 'business', resourceId: id,
      meta: { fields: Object.keys(dto) },
    });

    return updated;
  }

  /** Soft-disable. Keeps the audit trail and the computers intact. */
  async archive(actor: ActorContext, id: string) {
    this.acl.assertPlatformAdmin(actor);
    const existing = await this.acl.assertBusinessInScope(actor, id);

    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isArchived: true, isActive: false },
    });

    await this.audit.log({
      tenantId: existing.tenantId, customerId: id, actorId: actor.userId, actorIp: actor.ip,
      action: 'BUSINESS_DISABLED', resource: 'business', resourceId: id, meta: { archived: true },
    });
    return updated;
  }

  /**
   * Hard delete — refused unless the business is genuinely empty. "Delete
   * businesses when safe" means exactly that: no computers, no users, no
   * sessions left pointing at it.
   */
  async remove(actor: ActorContext, id: string) {
    this.acl.assertPlatformAdmin(actor);
    const existing = await this.acl.assertBusinessInScope(actor, id);

    const [endpoints, members, sessions, sites] = await Promise.all([
      this.prisma.endpoint.count({ where: { customerId: id } }),
      this.prisma.membership.count({ where: { customerId: id } }),
      this.prisma.supportSession.count({ where: { customerId: id } }),
      this.prisma.site.count({ where: { customerId: id } }),
    ]);

    const blockers: string[] = [];
    if (endpoints) blockers.push(`${endpoints} computer(s)`);
    if (members) blockers.push(`${members} user(s)`);
    if (sessions) blockers.push(`${sessions} session record(s)`);
    if (sites) blockers.push(`${sites} site(s)`);

    if (blockers.length > 0) {
      throw new ConflictException(
        `This business still has ${blockers.join(', ')}. Move or remove them first, or disable the business instead.`,
      );
    }

    // Detach audit history rather than deleting it — the record of what
    // happened outlives the business it happened in.
    await this.prisma.activityLog.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await this.prisma.customer.delete({ where: { id } });

    await this.audit.log({
      tenantId: existing.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'BUSINESS_DELETED', resource: 'business', resourceId: id,
      meta: { name: existing.name },
    });
    return { success: true };
  }

  // ── People ────────────────────────────────────────────────────────────────

  /** Everyone who belongs to this business. */
  async listUsers(actor: ActorContext, businessId: string) {
    await this.acl.assertBusinessInScope(actor, businessId);

    return this.prisma.membership.findMany({
      where: { customerId: businessId },
      include: {
        user: {
          select: {
            id: true, email: true, firstName: true, lastName: true, status: true,
            createdAt: true, phone: true, jobTitle: true, isPlatformAdmin: true,
            mfaMethods: { where: { type: 'TOTP', isActive: true }, select: { id: true } },
          },
        },
        role: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Add a person to a business.
   *
   * A Platform Admin may add anyone to any business. A Business Owner may add
   * Business Users to their own business and nothing else — the level is
   * checked here rather than taken from the request.
   */
  async addUser(
    actor: ActorContext,
    businessId: string,
    dto: {
      email: string;
      firstName?: string;
      lastName?: string;
      level: 'BUSINESS_OWNER' | 'BUSINESS_USER';
      capabilities?: string[];
    },
  ) {
    const business = await this.acl.assertBusinessInScope(actor, businessId);

    if (dto.level === 'BUSINESS_OWNER' && !actor.isPlatformAdmin) {
      throw new BadRequestException('Only a Platform Admin can create a Business Owner');
    }
    if (!actor.isPlatformAdmin) {
      this.acl.assertBusinessOwner(actor);
    }

    const email = dto.email.toLowerCase().trim();
    const roleType = dto.level === 'BUSINESS_OWNER' ? RoleType.BUSINESS_OWNER : RoleType.BUSINESS_USER;

    const role = await this.prisma.role.findFirst({
      where: { tenantId: business.tenantId, type: roleType },
      select: { id: true },
    });
    if (!role) throw new BadRequestException(`System role ${roleType} is missing — re-run the seed`);

    let user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      const clash = await this.prisma.membership.findFirst({ where: { userId: user.id } });
      if (clash) {
        throw new ConflictException(
          clash.customerId === businessId
            ? 'That person is already in this business'
            : 'That email already belongs to another business',
        );
      }
    } else {
      // Placeholder credential — the invitation token is what actually lets
      // them in, and it is returned to the caller, never emailed from here.
      const passwordHash = await argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName: dto.firstName ?? '',
          lastName: dto.lastName ?? '',
          status: 'INVITED',
        },
      });
    }

    const capabilities =
      roleType === RoleType.BUSINESS_OWNER
        ? []
        : dto.capabilities
          ? sanitizeCapabilities(dto.capabilities)
          : DEFAULT_BUSINESS_USER_CAPABILITIES;

    const membership = await this.prisma.membership.create({
      data: {
        userId: user.id,
        tenantId: business.tenantId,
        customerId: businessId,
        roleId: role.id,
        capabilities,
        isActive: true,
      },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
        role: { select: { id: true, name: true, type: true } },
      },
    });

    const inviteToken = randomBytes(32).toString('hex');
    await this.prisma.invitation.create({
      data: {
        tenantId: business.tenantId,
        invitedById: actor.userId,
        email,
        roleId: role.id,
        token: inviteToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await this.audit.log({
      tenantId: business.tenantId, customerId: businessId,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_INVITED', resource: 'membership', resourceId: membership.id,
      meta: { email, level: roleType },
    });

    return { membership, inviteToken };
  }

  /** Set exactly which capabilities a Business User holds. */
  async setUserCapabilities(
    actor: ActorContext,
    businessId: string,
    targetUserId: string,
    capabilities: string[],
  ) {
    const business = await this.acl.assertBusinessInScope(actor, businessId);
    if (!actor.isPlatformAdmin) this.acl.assertBusinessOwner(actor);

    const membership = await this.prisma.membership.findFirst({
      where: { userId: targetUserId, customerId: businessId },
      include: {
        role: { select: { type: true } },
        user: { select: { id: true, email: true, isPlatformAdmin: true } },
      },
    });
    if (!membership) throw new NotFoundException('User not found in this business');

    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId: membership.user.id,
    });

    if (membership.role.type === RoleType.BUSINESS_OWNER) {
      throw new BadRequestException(
        'A Business Owner already holds every business permission — capabilities apply to Business Users.',
      );
    }

    // Nobody edits their own permissions, not even an owner.
    if (targetUserId === actor.userId) {
      throw new BadRequestException('You cannot change your own permissions');
    }

    const clean = sanitizeCapabilities(capabilities);
    const updated = await this.prisma.membership.update({
      where: { id: membership.id },
      data: { capabilities: clean },
      select: { id: true, capabilities: true },
    });

    await this.audit.log({
      tenantId: business.tenantId, customerId: businessId,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_CAPABILITIES_UPDATED', resource: 'membership', resourceId: membership.id,
      meta: { userId: targetUserId, from: membership.capabilities, to: clean },
    });

    return updated;
  }

  /** Suspend / restore a Business User's access. */
  async setUserActive(actor: ActorContext, businessId: string, targetUserId: string, active: boolean) {
    const business = await this.acl.assertBusinessInScope(actor, businessId);
    if (!actor.isPlatformAdmin) this.acl.assertBusinessOwner(actor);
    if (targetUserId === actor.userId) throw new BadRequestException('You cannot disable your own account');

    const membership = await this.prisma.membership.findFirst({
      where: { userId: targetUserId, customerId: businessId },
      include: {
        role: { select: { type: true } },
        user: { select: { id: true, email: true, isPlatformAdmin: true } },
      },
    });
    if (!membership) throw new NotFoundException('User not found in this business');

    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId: membership.user.id,
    });

    await this.prisma.membership.update({ where: { id: membership.id }, data: { isActive: active } });
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: active ? 'ACTIVE' : 'SUSPENDED' },
    });

    await this.audit.log({
      tenantId: business.tenantId, customerId: businessId,
      actorId: actor.userId, actorIp: actor.ip,
      action: active ? 'USER_UPDATED' : 'USER_SUSPENDED',
      resource: 'membership', resourceId: membership.id,
      meta: { userId: targetUserId, email: membership.user.email, active },
    });
    return { success: true };
  }

  /** Remove someone from a business entirely. */
  async removeUser(actor: ActorContext, businessId: string, targetUserId: string) {
    const business = await this.acl.assertBusinessInScope(actor, businessId);
    if (!actor.isPlatformAdmin) this.acl.assertBusinessOwner(actor);
    if (targetUserId === actor.userId) throw new BadRequestException('You cannot remove your own account');

    const membership = await this.prisma.membership.findFirst({
      where: { userId: targetUserId, customerId: businessId },
      include: {
        role: { select: { type: true } },
        user: { select: { id: true, email: true, isPlatformAdmin: true } },
      },
    });
    if (!membership) throw new NotFoundException('User not found in this business');

    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId: membership.user.id,
    });

    // Drop every per-computer grant they held in this business, then the
    // membership. Leaving ComputerAccess rows behind would resurrect access
    // if the same person were re-added later.
    await this.prisma.computerAccess.deleteMany({
      where: { userId: targetUserId, endpoint: { customerId: businessId } },
    });
    await this.prisma.membership.delete({ where: { id: membership.id } });

    const remaining = await this.prisma.membership.count({ where: { userId: targetUserId } });
    if (remaining === 0 && !membership.user.isPlatformAdmin) {
      await this.prisma.user.update({ where: { id: targetUserId }, data: { status: 'DELETED' } });
    }

    await this.audit.log({
      tenantId: business.tenantId, customerId: businessId,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'USER_DELETED', resource: 'membership', resourceId: membership.id,
      meta: { userId: targetUserId, email: membership.user.email },
    });
    return { success: true };
  }

  /** Issue a fresh invitation token, invalidating whatever they had. */
  async resetUserAccess(actor: ActorContext, businessId: string, targetUserId: string) {
    const business = await this.acl.assertBusinessInScope(actor, businessId);
    if (!actor.isPlatformAdmin) this.acl.assertBusinessOwner(actor);

    const membership = await this.prisma.membership.findFirst({
      where: { userId: targetUserId, customerId: businessId },
      include: {
        role: { select: { id: true, type: true } },
        user: { select: { id: true, email: true, isPlatformAdmin: true } },
      },
    });
    if (!membership) throw new NotFoundException('User not found in this business');

    this.acl.assertMayManage(actor, {
      roleType: membership.role.type,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      userId: membership.user.id,
    });

    const inviteToken = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      // Burn any outstanding invitation so only the newest token works.
      this.prisma.invitation.deleteMany({
        where: { email: membership.user.email, acceptedAt: null },
      }),
      this.prisma.invitation.create({
        data: {
          tenantId: business.tenantId,
          invitedById: actor.userId,
          email: membership.user.email,
          roleId: membership.role.id,
          token: inviteToken,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      }),
      // Invalidate the current password and every MFA method.
      this.prisma.user.update({
        where: { id: targetUserId },
        data: { passwordHash: '', status: 'INVITED' },
      }),
      this.prisma.userMfaMethod.updateMany({
        where: { userId: targetUserId },
        data: { isActive: false },
      }),
    ]);

    await this.audit.log({
      tenantId: business.tenantId, customerId: businessId,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'MFA_RESET', resource: 'user', resourceId: targetUserId,
      meta: { accessReset: true },
    });

    return { inviteToken };
  }
}
