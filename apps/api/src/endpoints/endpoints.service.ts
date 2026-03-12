import {
  Injectable, NotFoundException, ConflictException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import type { CreateEndpointDto, UpdateEndpointDto } from './dto/create-endpoint.dto';

@Injectable()
export class EndpointsService {
  private readonly encKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    this.encKey = Buffer.from(this.config.get<string>('ENCRYPTION_KEY', '0'.repeat(64)), 'hex');
  }

  private encryptPassword(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  private decryptPassword(data: string): string {
    const [ivHex, tagHex, encHex] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  }

  async setPassword(tenantId: string, id: string, password: string | null): Promise<void> {
    await this.assertOwnership(tenantId, id);
    const node = await this.prisma.rustdeskNode.findUnique({ where: { endpointId: id } });
    if (!node) throw new NotFoundException('No RustDesk node linked to this endpoint');
    await this.prisma.rustdeskNode.update({
      where: { endpointId: id },
      data: { permanentPassword: password ? this.encryptPassword(password) : null },
    });
  }

  async getPassword(tenantId: string, id: string): Promise<string | null> {
    await this.assertOwnership(tenantId, id);
    const node = await this.prisma.rustdeskNode.findUnique({ where: { endpointId: id }, select: { permanentPassword: true } });
    if (!node?.permanentPassword) return null;
    return this.decryptPassword(node.permanentPassword);
  }

  async findAll(tenantId: string, params: {
    search?: string; customerId?: string; status?: string;
    tag?: string; platform?: string; page?: number; limit?: number;
  }) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      tenantId,
      ...(params.customerId === 'null' ? { customerId: null } : params.customerId ? { customerId: params.customerId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.platform ? { platform: params.platform } : {}),
      ...(params.search ? {
        OR: [
          { name: { contains: params.search, mode: 'insensitive' } },
          { hostname: { contains: params.search, mode: 'insensitive' } },
          { aliases: { some: { alias: { contains: params.search, mode: 'insensitive' } } } },
          { rustdeskNode: { rustdeskId: { contains: params.search, mode: 'insensitive' } } },
        ],
      } : {}),
      ...(params.tag ? { tags: { some: { tag: params.tag } } } : {}),
    };

    const [endpoints, total] = await Promise.all([
      this.prisma.endpoint.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          customer: { select: { id: true, name: true } },
          site: { select: { id: true, name: true } },
          rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true, permanentPassword: true } },
          tags: true,
          aliases: { where: { isPrimary: true }, take: 1 },
          enrollment: { select: { status: true } },
        },
      }),
      this.prisma.endpoint.count({ where }),
    ]);

    return { endpoints, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id, tenantId },
      include: {
        customer: true,
        site: true,
        endpointGroup: true,
        rustdeskNode: true,
        enrollment: true,
        aliases: true,
        tags: true,
        noteRels: {
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        supportSessions: {
          include: { technician: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return endpoint;
  }

  async create(tenantId: string, actorId: string, dto: CreateEndpointDto) {
    const endpoint = await this.prisma.endpoint.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        customerId: dto.customerId,
        siteId: dto.siteId,
        endpointGroupId: dto.endpointGroupId,
        hostname: dto.hostname,
        platform: dto.platform,
        osVersion: dto.osVersion,
        ipAddress: dto.ipAddress,
        macAddress: dto.macAddress,
        serialNumber: dto.serialNumber,
        isManaged: dto.isManaged ?? false,
        enrollment: { create: { status: 'PENDING' } },
        ...(dto.rustdeskId ? {
          rustdeskNode: { create: { tenantId, rustdeskId: dto.rustdeskId, platform: dto.platform } },
        } : {}),
      },
    });

    await this.audit.log({ action: 'ENDPOINT_CREATED', actorId, tenantId, resource: 'endpoint', resourceId: endpoint.id, meta: { name: endpoint.name } });
    return endpoint;
  }

  async update(tenantId: string, id: string, actorId: string, dto: UpdateEndpointDto) {
    await this.assertOwnership(tenantId, id);
    const endpoint = await this.prisma.endpoint.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
        ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
        ...(dto.hostname !== undefined ? { hostname: dto.hostname } : {}),
        ...(dto.platform !== undefined ? { platform: dto.platform } : {}),
        ...(dto.osVersion !== undefined ? { osVersion: dto.osVersion } : {}),
        ...(dto.ipAddress !== undefined ? { ipAddress: dto.ipAddress } : {}),
        ...(dto.isManaged !== undefined ? { isManaged: dto.isManaged } : {}),
      },
    });
    await this.audit.log({ action: 'ENDPOINT_UPDATED', actorId, tenantId, resource: 'endpoint', resourceId: id });
    return endpoint;
  }

  async archive(tenantId: string, id: string, actorId: string) {
    await this.assertOwnership(tenantId, id);
    const endpoint = await this.prisma.endpoint.update({ where: { id }, data: { status: 'ARCHIVED' } });
    await this.audit.log({ action: 'ENDPOINT_ARCHIVED', actorId, tenantId, resource: 'endpoint', resourceId: id });
    return endpoint;
  }

  async addTag(tenantId: string, id: string, tag: string) {
    await this.assertOwnership(tenantId, id);
    try {
      await this.prisma.endpointTag.create({ data: { endpointId: id, tag } });
    } catch {
      throw new ConflictException('Tag already exists');
    }
  }

  async removeTag(tenantId: string, id: string, tag: string) {
    await this.assertOwnership(tenantId, id);
    await this.prisma.endpointTag.deleteMany({ where: { endpointId: id, tag } });
  }

  async addAlias(tenantId: string, id: string, alias: string, isPrimary = false) {
    await this.assertOwnership(tenantId, id);
    if (isPrimary) {
      await this.prisma.endpointAlias.updateMany({ where: { endpointId: id, isPrimary: true }, data: { isPrimary: false } });
    }
    return this.prisma.endpointAlias.create({ data: { endpointId: id, alias, isPrimary } });
  }

  async removeAlias(tenantId: string, id: string, aliasId: string) {
    await this.assertOwnership(tenantId, id);
    await this.prisma.endpointAlias.deleteMany({ where: { id: aliasId, endpointId: id } });
  }

  async setRustdeskNode(tenantId: string, endpointId: string, rustdeskId: string, meta?: { platform?: string; version?: string; hostname?: string }) {
    await this.assertOwnership(tenantId, endpointId);
    const dupe = await this.prisma.rustdeskNode.findFirst({ where: { tenantId, rustdeskId, endpointId: { not: endpointId } } });
    if (dupe) throw new ConflictException('RustDesk ID already assigned to another endpoint');
    return this.prisma.rustdeskNode.upsert({
      where: { endpointId },
      create: { tenantId, endpointId, rustdeskId, ...meta },
      update: { rustdeskId, lastSeenAt: new Date(), ...meta },
    });
  }

  private async assertOwnership(tenantId: string, id: string) {
    const ep = await this.prisma.endpoint.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!ep) throw new NotFoundException('Endpoint not found');
    return ep;
  }
}
