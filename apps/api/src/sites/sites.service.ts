import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

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

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(tenantId: string, customerId?: string) {
    return this.prisma.site.findMany({
      where: {
        tenantId,
        ...(customerId ? { customerId } : {}),
        isActive: true,
      },
      include: {
        customer: { select: { id: true, name: true } },
        _count: { select: { endpoints: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const site = await this.prisma.site.findFirst({
      where: { id, tenantId },
      include: {
        customer: { select: { id: true, name: true } },
        endpoints: {
          select: { id: true, name: true, status: true, platform: true },
        },
      },
    });
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return site;
  }

  async create(
    tenantId: string,
    actorId: string,
    dto: CreateSiteDto & { customerId: string },
  ) {
    // Validate customer belongs to the tenant
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, tenantId, isArchived: false },
    });
    if (!customer) {
      throw new BadRequestException(
        `Customer ${dto.customerId} not found in this tenant`,
      );
    }

    const site = await this.prisma.site.create({
      data: {
        tenantId,
        customerId: dto.customerId,
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
      include: {
        customer: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      tenantId,
      actorId,
      action: 'SITE_CREATED',
      resource: 'site',
      resourceId: site.id,
      meta: { name: site.name, customerId: dto.customerId },
    });

    return site;
  }

  async update(
    tenantId: string,
    id: string,
    actorId: string,
    dto: UpdateSiteDto,
  ) {
    await this.findOne(tenantId, id);

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
      tenantId,
      actorId,
      action: 'SITE_UPDATED',
      resource: 'site',
      resourceId: id,
      meta: dto as Record<string, unknown>,
    });

    return updated;
  }

  async delete(tenantId: string, id: string, actorId: string) {
    await this.findOne(tenantId, id);

    const updated = await this.prisma.site.update({
      where: { id },
      data: { isActive: false },
    });

    await this.audit.log({
      tenantId,
      actorId,
      action: 'SITE_DELETED',
      resource: 'site',
      resourceId: id,
      meta: {},
    });

    return updated;
  }
}
