import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

interface CreateCustomerDto {
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

interface UpdateCustomerDto {
  name?: string;
  code?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  notes?: string;
  isActive?: boolean;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(tenantId: string, search?: string) {
    return this.prisma.customer.findMany({
      where: {
        tenantId,
        isArchived: false,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        _count: { select: { endpoints: true, sites: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId, isArchived: false },
      include: {
        sites: { where: { isActive: true } },
        endpoints: {
          where: { status: { not: 'ARCHIVED' } },
          include: { rustdeskNode: { select: { rustdeskId: true } } },
        },
        _count: { select: { endpoints: true, sites: true } },
      },
    });
    if (!customer) throw new NotFoundException(`Customer ${id} not found`);
    return customer;
  }

  async create(tenantId: string, actorId: string, dto: CreateCustomerDto) {
    const customer = await this.prisma.customer.create({
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
      tenantId,
      actorId,
      action: 'CUSTOMER_CREATED',
      resource: 'customer',
      resourceId: customer.id,
      meta: { name: customer.name },
    });

    return customer;
  }

  async update(tenantId: string, id: string, actorId: string, dto: UpdateCustomerDto) {
    await this.findOne(tenantId, id);

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
      },
    });

    await this.audit.log({ tenantId, actorId, action: 'CUSTOMER_UPDATED', resource: 'customer', resourceId: id, meta: dto as Record<string, unknown> });
    return updated;
  }

  async archive(tenantId: string, id: string, actorId: string) {
    await this.findOne(tenantId, id);
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isArchived: true, isActive: false },
    });
    await this.audit.log({ tenantId, actorId, action: 'CUSTOMER_ARCHIVED', resource: 'customer', resourceId: id, meta: {} });
    return updated;
  }

  async invitePortalUser(
    tenantId: string,
    customerId: string,
    actorId: string,
    email: string,
    firstName: string,
    lastName: string,
  ) {
    // Verify customer exists in tenant
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException('Customer not found');

    // Check tenant allows customer portal
    const settings = await this.prisma.tenantSettings.findUnique({ where: { tenantId }, select: { allowCustomerPortal: true } });
    if (!settings?.allowCustomerPortal) throw new BadRequestException('Customer portal is not enabled for this tenant');

    // Find or create user
    let user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      const hash = await argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
      user = await this.prisma.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash: hash,
          firstName,
          lastName,
          status: 'INVITED',
        },
      });
    }

    // Find the Customer role for this tenant
    const customerRole = await this.prisma.role.findFirst({ where: { tenantId, type: 'CUSTOMER' } });
    if (!customerRole) throw new BadRequestException('Customer role not found. Re-run seed to create system roles.');

    // Create membership linking user to tenant + customer
    const existing = await this.prisma.membership.findFirst({ where: { userId: user.id, tenantId } });
    if (existing) throw new ConflictException('User already has access to this tenant');

    await this.prisma.membership.create({
      data: { userId: user.id, tenantId, roleId: customerRole.id, customerId },
    });

    // Generate a password reset token / invite token
    const inviteToken = randomBytes(32).toString('hex');
    await this.prisma.invitation.create({
      data: {
        tenantId,
        invitedById: actorId,
        email: email.toLowerCase(),
        roleId: customerRole.id,
        token: inviteToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { user: { id: user.id, email: user.email }, inviteToken };
  }

  async enablePortal(tenantId: string, customerId: string, _actorId: string, enabled: boolean) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException('Customer not found');

    return this.prisma.customer.update({
      where: { id: customerId },
      data: { portalEnabled: enabled },
    });
  }

  async listPortalUsers(tenantId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException('Customer not found');

    return this.prisma.membership.findMany({
      where: { tenantId, customerId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
        role: { select: { id: true, name: true, type: true } },
      },
    });
  }
}
