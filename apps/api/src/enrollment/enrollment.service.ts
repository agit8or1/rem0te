import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateClaimTokenDto, ClaimEndpointDto } from './dto/enrollment.dto';

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly tokenTtlHours = 24;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createClaimToken(
    tenantId: string,
    actorId: string,
    dto: CreateClaimTokenDto,
    actorIp?: string,
  ) {
    if (dto.endpointId) {
      const endpoint = await this.prisma.endpoint.findFirst({
        where: { id: dto.endpointId, tenantId },
      });
      if (!endpoint) throw new NotFoundException(`Endpoint ${dto.endpointId} not found`);
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.tokenTtlHours * 60 * 60 * 1000);

    const record = await this.prisma.deviceClaimToken.create({
      data: {
        tenantId,
        token,
        expiresAt,
        endpointId: dto.endpointId ?? null,
        customerName: dto.customerName ?? null,
        siteName: dto.siteName ?? null,
        description: dto.description ?? null,
      },
    });

    await this.audit.log({
      tenantId,
      actorId,
      actorIp,
      action: 'CLAIM_TOKEN_CREATED',
      resource: 'device_claim_token',
      resourceId: record.id,
      meta: { endpointId: dto.endpointId, description: dto.description },
    });

    return record;
  }

  async listClaimTokens(tenantId: string) {
    return this.prisma.deviceClaimToken.findMany({
      where: { tenantId },
      include: {
        endpoint: { select: { id: true, name: true, hostname: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async claimEndpoint(dto: ClaimEndpointDto, claimedByIp?: string) {
    const record = await this.prisma.deviceClaimToken.findUnique({
      where: { token: dto.token },
    });

    if (!record) throw new NotFoundException('Claim token not found');
    if (record.claimedAt) throw new BadRequestException('Token has already been used');
    if (record.expiresAt < new Date()) throw new BadRequestException('Token has expired');

    // Check for duplicate RustDesk ID within tenant
    const existingNode = await this.prisma.rustdeskNode.findFirst({
      where: { rustdeskId: dto.rustdeskId, tenantId: record.tenantId },
    });
    if (existingNode) {
      throw new BadRequestException(
        `RustDesk ID ${dto.rustdeskId} is already registered to endpoint ${existingNode.endpointId}`,
      );
    }

    let endpoint = record.endpointId
      ? await this.prisma.endpoint.findUnique({ where: { id: record.endpointId } })
      : null;

    if (endpoint) {
      // Update existing endpoint
      endpoint = await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          hostname: dto.hostname ?? endpoint.hostname,
          platform: dto.platform ?? endpoint.platform,
          osVersion: dto.osVersion ?? endpoint.osVersion,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'ACTIVE',
        },
      });
    } else {
      // Create new endpoint from claim context
      endpoint = await this.prisma.endpoint.create({
        data: {
          tenantId: record.tenantId,
          name: dto.hostname ?? dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          osVersion: dto.osVersion ?? null,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'ACTIVE',
        },
      });
    }

    // Upsert RustdeskNode — the join between endpoint and RustDesk ID
    await this.prisma.rustdeskNode.upsert({
      where: { endpointId: endpoint.id },
      create: {
        tenantId: record.tenantId,
        endpointId: endpoint.id,
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname ?? null,
        platform: dto.platform ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname ?? undefined,
        platform: dto.platform ?? undefined,
        lastSeenAt: new Date(),
      },
    });

    // Mark token as claimed
    await this.prisma.deviceClaimToken.update({
      where: { id: record.id },
      data: {
        claimedAt: new Date(),
        claimedByIp: claimedByIp ?? null,
        endpointId: endpoint.id,
      },
    });

    await this.audit.log({
      tenantId: record.tenantId,
      action: 'ENDPOINT_CLAIMED',
      resource: 'endpoint',
      resourceId: endpoint.id,
      actorIp: claimedByIp,
      meta: { rustdeskId: dto.rustdeskId, hostname: dto.hostname },
    });

    return { endpoint, tenantId: record.tenantId };
  }

  async revokeClaimToken(tenantId: string, tokenId: string) {
    const record = await this.prisma.deviceClaimToken.findFirst({
      where: { id: tokenId, tenantId },
    });
    if (!record) throw new NotFoundException('Token not found');

    if (record.claimedAt) {
      throw new BadRequestException('Cannot revoke an already-claimed token');
    }

    await this.prisma.deviceClaimToken.delete({ where: { id: tokenId } });
    return { revoked: true };
  }
}
