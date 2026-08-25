import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

interface CreateSiteDto {
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

interface UpdateSiteDto {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  isActive?: boolean;
}

/**
 * Sites are locations inside a business. They inherit the business boundary
 * exactly: a site query is a business query with an extra filter.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  async findAll(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);
    return this.prisma.site.findMany({
      where: {
        ...(scope ? { customerId: scope } : {}),
        isActive: true,
      },
      include: {
        customer: { select: { id: true, name: true } },
        _count: { select: { endpoints: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(actor: ActorContext, id: string) {
    const site = await this.assertInScope(actor, id);
    return this.prisma.site.findUnique({
      where: { id: site.id },
      include: {
        customer: { select: { id: true, name: true } },
        endpoints: {
          select: { id: true, name: true, status: true, platform: true },
        },
      },
    });
  }

  async create(actor: ActorContext, dto: CreateSiteDto & { businessId?: string; customerId?: string }) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    // The business is resolved from the caller's scope, not taken on trust.
    const businessId = this.acl.requireScope(actor, dto.businessId ?? dto.customerId);
    const business = await this.prisma.customer.findFirst({
      where: { id: businessId, isArchived: false },
      select: { id: true, tenantId: true },
    });
    if (!business) throw new BadRequestException('Business not found');

    const site = await this.prisma.site.create({
      data: {
        tenantId: business.tenantId,
        customerId: business.id,
        name: dto.name,
        address: dto.address ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        country: dto.country ?? null,
        postalCode: dto.postalCode ?? null,
        contactName: dto.contactName ?? null,
        contactEmail: dto.contactEmail ?? null,
        contactPhone: dto.contactPhone ?? null,
        notes: dto.notes ?? null,
        isActive: true,
      },
      include: { customer: { select: { id: true, name: true } } },
    });

    await this.audit.log({
      tenantId: business.tenantId, customerId: business.id,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SITE_CREATED', resource: 'site', resourceId: site.id,
      meta: { name: site.name, businessId: business.id },
    });

    return site;
  }

  async update(actor: ActorContext, id: string, dto: UpdateSiteDto) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    const site = await this.assertInScope(actor, id);

    const updated = await this.prisma.site.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.state !== undefined && { state: dto.state }),
        ...(dto.country !== undefined && { country: dto.country }),
        ...(dto.postalCode !== undefined && { postalCode: dto.postalCode }),
        ...(dto.contactName !== undefined && { contactName: dto.contactName }),
        ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
        ...(dto.contactPhone !== undefined && { contactPhone: dto.contactPhone }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    await this.audit.log({
      tenantId: site.tenantId, customerId: site.customerId,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SITE_UPDATED', resource: 'site', resourceId: id,
      meta: dto as Record<string, unknown>,
    });

    return updated;
  }

  async delete(actor: ActorContext, id: string) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_REMOVE);
    const site = await this.assertInScope(actor, id);

    const updated = await this.prisma.site.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.log({
      tenantId: site.tenantId, customerId: site.customerId,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SITE_DELETED', resource: 'site', resourceId: id, meta: {},
    });

    return updated;
  }

  /** A site is reachable only through the business that owns it. */
  private async assertInScope(actor: ActorContext, id: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: { id: true, tenantId: true, customerId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (!actor.isPlatformAdmin && site.customerId !== actor.businessId) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }
}
