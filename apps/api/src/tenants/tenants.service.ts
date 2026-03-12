import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CreateTenantDto,
  UpdateBrandingDto,
  UpdateSettingsDto,
  UpdateTenantDto,
} from './dto/create-tenant.dto';

const SYSTEM_ROLES: { name: string; type: RoleType }[] = [
  { name: 'Tenant Owner', type: RoleType.TENANT_OWNER },
  { name: 'Tenant Admin', type: RoleType.TENANT_ADMIN },
  { name: 'Technician', type: RoleType.TECHNICIAN },
  { name: 'Billing Admin', type: RoleType.BILLING_ADMIN },
  { name: 'Read Only', type: RoleType.READ_ONLY },
  { name: 'Customer Portal', type: RoleType.CUSTOMER },
];

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll() {
    return this.prisma.tenant.findMany({
      include: {
        _count: { select: { memberships: true, customers: true, endpoints: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        settings: true,
        branding: true,
        _count: { select: { memberships: true, customers: true, endpoints: true } },
      },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return tenant;
  }

  async findBySlug(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
      include: { branding: true, settings: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant '${slug}' not found`);
    return tenant;
  }

  async create(actorId: string, dto: CreateTenantDto) {
    const existing = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new BadRequestException(`Slug '${dto.slug}' is already taken`);

    const tenant = await this.prisma.$transaction(async (tx) => {
      const newTenant = await tx.tenant.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          settings: {
            create: {
              requireMfa: dto.requireMfa ?? false,
              sessionTimeoutMinutes: dto.sessionTimeoutMinutes ?? 480,
              passwordMinLength: dto.passwordMinLength ?? 12,
              allowPasswordReset: true,
              rustdeskRelayHost: dto.rustdeskRelayHost ?? null,
              rustdeskPublicKey: dto.rustdeskPublicKey ?? null,
            },
          },
          branding: {
            create: {
              portalTitle: dto.portalTitle ?? dto.name,
              logoUrl: dto.logoUrl ?? null,
              accentColor: dto.accentColor ?? '#3B82F6',
              supportEmail: dto.supportEmail ?? null,
              supportPhone: dto.supportPhone ?? null,
            },
          },
        },
        include: { settings: true, branding: true },
      });

      for (const role of SYSTEM_ROLES) {
        await tx.role.create({
          data: { tenantId: newTenant.id, name: role.name, type: role.type, isSystem: true },
        });
      }

      return newTenant;
    });

    await this.audit.log({
      tenantId: tenant.id,
      actorId,
      action: 'TENANT_CREATED',
      resource: 'tenant',
      resourceId: tenant.id,
      meta: { name: tenant.name, slug: tenant.slug },
    });

    return tenant;
  }

  async update(id: string, actorId: string, dto: UpdateTenantDto) {
    await this.findOne(id);
    const updated = await this.prisma.tenant.update({
      where: { id },
      data: { ...(dto.name !== undefined ? { name: dto.name } : {}) },
      include: { settings: true, branding: true },
    });
    await this.audit.log({ tenantId: id, actorId, action: 'TENANT_UPDATED', resource: 'tenant', resourceId: id, meta: dto as Record<string, unknown> });
    return updated;
  }

  async updateBranding(tenantId: string, actorId: string, dto: UpdateBrandingDto) {
    await this.findOne(tenantId);
    const branding = await this.prisma.tenantBranding.upsert({
      where: { tenantId },
      create: {
        tenantId,
        portalTitle: dto.portalTitle ?? 'Remote Support Portal',
        logoUrl: dto.logoUrl ?? null,
        accentColor: dto.accentColor ?? '#3B82F6',
        supportEmail: dto.supportEmail ?? null,
        supportPhone: dto.supportPhone ?? null,
        footerText: dto.footerText ?? null,
      },
      update: {
        ...(dto.portalTitle !== undefined ? { portalTitle: dto.portalTitle } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.accentColor !== undefined ? { accentColor: dto.accentColor } : {}),
        ...(dto.supportEmail !== undefined ? { supportEmail: dto.supportEmail } : {}),
        ...(dto.supportPhone !== undefined ? { supportPhone: dto.supportPhone } : {}),
        ...(dto.footerText !== undefined ? { footerText: dto.footerText } : {}),
      },
    });
    await this.audit.log({ tenantId, actorId, action: 'BRANDING_UPDATED', resource: 'tenant_branding', resourceId: tenantId, meta: dto as Record<string, unknown> });
    return branding;
  }

  async updateSettings(tenantId: string, actorId: string, dto: UpdateSettingsDto) {
    await this.findOne(tenantId);
    const settings = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        requireMfa: dto.requireMfa ?? false,
        sessionTimeoutMinutes: dto.sessionTimeoutMinutes ?? 480,
        passwordMinLength: dto.passwordMinLength ?? 12,
        allowPasswordReset: dto.allowPasswordReset ?? true,
        rustdeskRelayHost: dto.rustdeskRelayHost ?? null,
        rustdeskPublicKey: dto.rustdeskPublicKey ?? null,
        showDownloadPage: dto.showDownloadPage ?? true,
        allowCustomerPortal: dto.allowCustomerPortal ?? false,
      },
      update: {
        ...(dto.requireMfa !== undefined ? { requireMfa: dto.requireMfa } : {}),
        ...(dto.sessionTimeoutMinutes !== undefined ? { sessionTimeoutMinutes: dto.sessionTimeoutMinutes } : {}),
        ...(dto.passwordMinLength !== undefined ? { passwordMinLength: dto.passwordMinLength } : {}),
        ...(dto.allowPasswordReset !== undefined ? { allowPasswordReset: dto.allowPasswordReset } : {}),
        ...(dto.rustdeskRelayHost !== undefined ? { rustdeskRelayHost: dto.rustdeskRelayHost } : {}),
        ...(dto.rustdeskPublicKey !== undefined ? { rustdeskPublicKey: dto.rustdeskPublicKey } : {}),
        ...(dto.showDownloadPage !== undefined ? { showDownloadPage: dto.showDownloadPage } : {}),
        ...(dto.allowCustomerPortal !== undefined ? { allowCustomerPortal: dto.allowCustomerPortal } : {}),
      },
    });
    await this.audit.log({ tenantId, actorId, action: 'SETTINGS_UPDATED', resource: 'tenant_settings', resourceId: tenantId, meta: dto as Record<string, unknown> });
    return settings;
  }

  async getMembers(tenantId: string) {
    await this.findOne(tenantId);
    return this.prisma.membership.findMany({
      where: { tenantId },
      include: {
        user: {
          select: {
            id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true,
            mfaMethods: { where: { type: 'TOTP', isActive: true }, select: { id: true } },
          },
        },
        role: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async assignRole(tenantId: string, userId: string, roleId: string, actorId: string) {
    await this.findOne(tenantId);
    const membership = await this.prisma.membership.findFirst({ where: { tenantId, userId } });
    if (!membership) throw new NotFoundException(`User ${userId} not in tenant`);
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);

    const updated = await this.prisma.membership.update({
      where: { id: membership.id },
      data: { roleId },
      include: { user: { select: { id: true, email: true } }, role: { select: { id: true, name: true, type: true } } },
    });

    await this.audit.log({ tenantId, actorId, action: 'ROLE_ASSIGNED', resource: 'membership', resourceId: membership.id, meta: { userId, roleId, roleName: role.name } });
    return updated;
  }

  async listRoles(tenantId: string) {
    return this.prisma.role.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  async inviteMember(tenantId: string, actorId: string, email: string, roleId: string) {
    await this.findOne(tenantId);
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new Error(`Role ${roleId} not found in this tenant`);

    let user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      const existing = await this.prisma.membership.findFirst({ where: { userId: user.id, tenantId } });
      if (existing) throw new Error('User is already a member of this tenant');
    } else {
      // Create stub user in INVITED state
      user = await this.prisma.user.create({
        data: { email, passwordHash: '', firstName: '', lastName: '', status: 'INVITED', isPlatformAdmin: false },
      });
    }

    const membership = await this.prisma.membership.create({
      data: { tenantId, userId: user.id, roleId },
      include: { user: { select: { id: true, email: true } }, role: { select: { id: true, name: true } } },
    });

    await this.audit.log({
      tenantId,
      actorId,
      action: 'USER_INVITED',
      resource: 'membership',
      resourceId: membership.id,
      meta: { email, roleId, roleName: role.name },
    });

    return membership;
  }
}
