import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  UpdateBrandingDto,
  UpdateSettingsDto,
  UpdateTenantDto,
} from './dto/create-tenant.dto';

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
    if (!tenant) throw new NotFoundException('Platform configuration not found');
    return tenant;
  }

  async findBySlug(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
      include: { branding: true, settings: true },
    });
    if (!tenant) throw new NotFoundException('Platform configuration not found');
    return tenant;
  }

  // Member management moved to BusinessesService / UsersService, and the
  // platform container is created by the seed — this service is now only the
  // platform's own profile, branding and RustDesk settings.

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

}
