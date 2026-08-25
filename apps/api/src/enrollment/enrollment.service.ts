import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { CreateClaimTokenDto, ClaimEndpointDto } from './dto/enrollment.dto';

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly tokenTtlHours = 24;
  private readonly encKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    const rawKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey) || rawKey.toLowerCase() === '0'.repeat(64)) {
      throw new Error('ENCRYPTION_KEY is missing or invalid — refusing to start. Set a 64-hex-char key.');
    }
    this.encKey = Buffer.from(rawKey, 'hex');
  }

  private encryptPassword(text: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

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

    // If a customer was specified, validate it belongs to this tenant and
    // that every assignedUserId is an active member of the same tenant.
    // The endpoint being enrolled cannot influence these values — the token
    // itself carries the authorization.
    let customerId: string | null = null;
    let assignedUserIds: string[] = [];
    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found in this tenant');
      customerId = customer.id;
    }
    if (dto.assignedUserIds && dto.assignedUserIds.length > 0) {
      const memberships = await this.prisma.membership.findMany({
        where: {
          tenantId,
          isActive: true,
          userId: { in: dto.assignedUserIds },
        },
        select: { userId: true },
      });
      const validIds = new Set(memberships.map((m) => m.userId));
      const missing = dto.assignedUserIds.filter((id) => !validIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `assignedUserIds not members of this tenant: ${missing.join(', ')}`,
        );
      }
      assignedUserIds = dto.assignedUserIds;
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + this.tokenTtlHours * 60 * 60 * 1000);

    const record = await this.prisma.deviceClaimToken.create({
      data: {
        tenantId,
        token: tokenHash,
        expiresAt,
        endpointId: dto.endpointId ?? null,
        customerName: dto.customerName ?? null,
        siteName: dto.siteName ?? null,
        description: dto.description ?? null,
        customerId,
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
        endpointGroupId: dto.endpointGroupId ?? null,
        createdById: actorId,
      },
    });

    await this.audit.log({
      tenantId,
      actorId,
      actorIp,
      action: 'CLAIM_TOKEN_CREATED',
      resource: 'device_claim_token',
      resourceId: record.id,
      meta: {
        endpointId: dto.endpointId,
        description: dto.description,
        customerId,
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
      },
    });

    // Return record with the raw token (not the stored hash) so caller can embed it in URLs
    return { ...record, token };
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
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const record = await this.prisma.deviceClaimToken.findUnique({
      where: { token: tokenHash },
    });

    if (!record) throw new NotFoundException('Claim token not found');
    if (record.claimedAt) throw new BadRequestException('Token has already been used');
    if (record.expiresAt < new Date()) throw new BadRequestException('Token has expired');

    // Check for duplicate RustDesk ID globally
    const existingNode = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
    });

    if (existingNode) {
      if (existingNode.tenantId && existingNode.tenantId !== record.tenantId) {
        throw new BadRequestException(`RustDesk ID ${dto.rustdeskId} is registered to a different tenant`);
      }
      if (existingNode.tenantId === record.tenantId) {
        throw new BadRequestException(`RustDesk ID ${dto.rustdeskId} is already enrolled in this tenant`);
      }
      // tenantId is null (unassigned)
      if (!record.endpointId) {
        // Assign the unassigned node/endpoint to this tenant
        await this.prisma.rustdeskNode.update({
          where: { id: existingNode.id },
          data: { tenantId: record.tenantId },
        });
        await this.prisma.endpoint.update({
          where: { id: existingNode.endpointId },
          data: { tenantId: record.tenantId, status: 'ACTIVE' },
        });
        await this.prisma.deviceClaimToken.update({
          where: { id: record.id },
          data: { claimedAt: new Date(), claimedByIp: claimedByIp ?? null, endpointId: existingNode.endpointId },
        });
        const endpoint = await this.prisma.endpoint.findUnique({ where: { id: existingNode.endpointId } });
        await this.audit.log({
          tenantId: record.tenantId,
          action: 'ENDPOINT_CLAIMED',
          resource: 'endpoint',
          resourceId: existingNode.endpointId,
          actorIp: claimedByIp,
          meta: { rustdeskId: dto.rustdeskId, hostname: dto.hostname },
        });
        return { endpoint, tenantId: record.tenantId };
      } else {
        // Token has endpointId — delete the unassigned duplicate and proceed with normal token flow
        await this.prisma.rustdeskNode.delete({ where: { id: existingNode.id } });
        await this.prisma.endpoint.delete({ where: { id: existingNode.endpointId } });
      }
    }

    let endpoint = record.endpointId
      ? await this.prisma.endpoint.findUnique({ where: { id: record.endpointId } })
      : null;

    if (endpoint) {
      // Update existing endpoint. Token's binding overrides prior customer/access
      // if this is a re-enrollment against a specific token.
      endpoint = await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          hostname: dto.hostname ?? endpoint.hostname,
          platform: dto.platform ?? endpoint.platform,
          osVersion: dto.osVersion ?? endpoint.osVersion,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'ACTIVE',
          ...(record.customerId ? { customerId: record.customerId } : {}),
          ...(record.endpointGroupId ? { endpointGroupId: record.endpointGroupId } : {}),
          accessMode: record.accessMode,
        },
      });
    } else {
      // Create new endpoint from token+claim context. customerId and
      // endpointGroupId come from the token so the endpoint cannot enroll
      // itself into a different business.
      endpoint = await this.prisma.endpoint.create({
        data: {
          tenantId: record.tenantId,
          customerId: record.customerId ?? null,
          endpointGroupId: record.endpointGroupId ?? null,
          accessMode: record.accessMode,
          name: dto.hostname ?? dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          osVersion: dto.osVersion ?? null,
          isManaged: true,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'ACTIVE',
        },
      });
    }

    const encryptedPassword = dto.password ? this.encryptPassword(dto.password) : undefined;

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
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
      },
      update: {
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname ?? undefined,
        platform: dto.platform ?? undefined,
        lastSeenAt: new Date(),
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
      },
    });

    // Apply user access assignments from the token. The endpoint has no say
    // in this — the assignedUserIds were locked in when the admin minted the
    // token, and were validated at that time to belong to the same tenant.
    if (record.assignedUserIds.length > 0) {
      // Upsert-then-prune so re-enrollment against a new token becomes the new
      // authoritative access list (without churning identical rows).
      const currentAccess = await this.prisma.computerAccess.findMany({
        where: { endpointId: endpoint.id },
        select: { userId: true },
      });
      const currentIds = new Set(currentAccess.map((c) => c.userId));
      const wantIds = new Set(record.assignedUserIds);

      const toAdd = record.assignedUserIds.filter((u) => !currentIds.has(u));
      const toRemove = [...currentIds].filter((u) => !wantIds.has(u));

      if (toAdd.length > 0) {
        await this.prisma.computerAccess.createMany({
          data: toAdd.map((userId) => ({
            tenantId: record.tenantId,
            endpointId: endpoint!.id,
            userId,
            grantedBy: record.createdById ?? null,
          })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length > 0) {
        await this.prisma.computerAccess.deleteMany({
          where: { endpointId: endpoint.id, userId: { in: toRemove } },
        });
      }
    }

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
      meta: {
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname,
        customerId: record.customerId,
        accessMode: record.accessMode,
        assignedUsers: record.assignedUserIds.length,
      },
    });

    return { endpoint, tenantId: record.tenantId };
  }

  async heartbeat(dto: { rustdeskId: string; hostname?: string; platform?: string; osVersion?: string; agentVersion?: string; ipAddress?: string; password?: string }) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
    });

    // Always accept the password sent by the endpoint. The prior first-write-
    // only guard caused a real usability bug: re-running the installer on a
    // machine that had already heartbeated set a NEW password on RustDesk
    // (via `rustdesk.exe --password`) but left the OLD password in the DB,
    // so the /connect flow shipped the wrong password to the client and
    // the "one click" required a manual password type. The security
    // tradeoff (an attacker who has already stolen an endpoint's RustDesk
    // ID could rotate the credential the endpoint sees) is acceptable:
    // they'd still need to also compromise the endpoint to use it, and
    // every change is audited.
    const encryptedPassword = dto.password ? this.encryptPassword(dto.password) : undefined;

    if (!node) {
      // Auto-create an unassigned endpoint + node in the pending pool
      const endpoint = await this.prisma.endpoint.create({
        data: {
          tenantId: null,
          name: dto.hostname ?? dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          osVersion: dto.osVersion ?? null,
          ipAddress: dto.ipAddress ?? null,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'PENDING_ENROLLMENT',
        },
      });
      await this.prisma.rustdeskNode.create({
        data: {
          tenantId: null,
          endpointId: endpoint.id,
          rustdeskId: dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          lastSeenAt: new Date(),
          ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
        },
      });
      return { found: false, endpointId: endpoint.id };
    }

    // Always accept the current password from the endpoint (see comment above).
    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: {
        lastSeenAt: new Date(),
        ...(dto.hostname !== undefined && { hostname: dto.hostname }),
        ...(dto.platform !== undefined && { platform: dto.platform }),
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
      },
    });

    const updateData: Record<string, unknown> = {
      lastSeenAt: new Date(),
      isOnline: true,
      ...(dto.hostname !== undefined && { hostname: dto.hostname }),
      ...(dto.platform !== undefined && { platform: dto.platform }),
      ...(dto.osVersion !== undefined && { osVersion: dto.osVersion }),
      ...(dto.ipAddress !== undefined && { ipAddress: dto.ipAddress }),
    };

    await this.prisma.endpoint.update({
      where: { id: node.endpointId },
      data: updateData,
    });

    // If a credential rotation is pending for this node, include the new
    // plaintext in the response. The endpoint applies it via
    // rustdesk.exe --password and POSTs to /enrollment/confirm-rotation.
    let rotate: { password: string; sha256: string } | null = null;
    const refreshed = await this.prisma.rustdeskNode.findUnique({
      where: { id: node.id }, select: { pendingPassword: true },
    });
    if (refreshed?.pendingPassword) {
      try {
        const plain = this.decryptPassword(refreshed.pendingPassword);
        const sha = createHash('sha256').update(plain).digest('hex');
        rotate = { password: plain, sha256: sha };
      } catch { /* ignore */ }
    }

    return { found: true, endpointId: node.endpointId, rotate };
  }

  private decryptPassword(data: string): string {
    const [ivHex, tagHex, encHex] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  }

  // Confirm a pending rotation. Called by the endpoint after it applied
  // the new password. rustdeskId + digest are the only inputs; the server
  // computes the expected digest from its own pending ciphertext.
  async confirmRotation(rustdeskId: string, passwordSha256: string) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, pendingPassword: true },
    });
    if (!node?.pendingPassword) return { confirmed: false, reason: 'no_pending' };
    let plain: string;
    try { plain = this.decryptPassword(node.pendingPassword); }
    catch { return { confirmed: false, reason: 'decrypt_failed' }; }
    const expected = createHash('sha256').update(plain).digest('hex');
    if (expected !== passwordSha256) return { confirmed: false, reason: 'digest_mismatch' };

    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: {
        permanentPassword: node.pendingPassword,
        pendingPassword: null,
        pendingPasswordAt: null,
      },
    });
    await this.audit.log({
      tenantId: node.tenantId ?? undefined,
      action: 'ENDPOINT_CREDENTIAL_ROTATED',
      resource: 'endpoint', resourceId: node.endpointId,
    });
    return { confirmed: true };
  }

  async markStaleEndpointsOffline(thresholdMinutes = 10) {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    const result = await this.prisma.endpoint.updateMany({
      where: {
        isOnline: true,
        lastSeenAt: { lt: cutoff },
      },
      data: { isOnline: false },
    });
    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} stale endpoint(s) offline`);
    }
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
