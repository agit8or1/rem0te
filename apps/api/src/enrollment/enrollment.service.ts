import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { CreateClaimTokenDto, ClaimEndpointDto } from './dto/enrollment.dto';

const execFileAsync = promisify(execFile);

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly tokenTtlHours = 24;
  private readonly encKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly acl: AccessControlService,
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

  /**
   * Mint a managed-device enrollment token.
   *
   * The business the device will land in is decided here, from the caller's
   * scope — never by the machine that later redeems the token. Everything the
   * token carries (business, access mode, assigned users) is validated now,
   * so a device can only ever enroll itself where an authorised person said
   * it could.
   */
  async createClaimToken(actor: ActorContext, dto: CreateClaimTokenDto & { businessId?: string }) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_ADD);

    const businessId = this.acl.requireScope(actor, dto.businessId ?? dto.customerId);
    const business = await this.prisma.customer.findFirst({
      where: { id: businessId, isArchived: false },
      select: { id: true, tenantId: true, name: true },
    });
    if (!business) throw new NotFoundException('Business not found');

    if (dto.endpointId) {
      // Re-enrolling an existing computer: it must already be in this business.
      await this.acl.assertEndpointInScope(actor, dto.endpointId);
    }

    // Every assigned user must belong to the SAME business as the device.
    // Without this check a token could hand a stranger standing access to a
    // machine the moment it enrolls.
    let assignedUserIds: string[] = [];
    if (dto.assignedUserIds && dto.assignedUserIds.length > 0) {
      const memberships = await this.prisma.membership.findMany({
        where: { customerId: businessId, isActive: true, userId: { in: dto.assignedUserIds } },
        select: { userId: true },
      });
      const validIds = new Set(memberships.map((m) => m.userId));
      const missing = dto.assignedUserIds.filter((id) => !validIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `These users are not active members of ${business.name}: ${missing.join(', ')}`,
        );
      }
      assignedUserIds = dto.assignedUserIds;
    }

    if (dto.endpointGroupId) {
      const group = await this.prisma.endpointGroup.findFirst({
        where: { id: dto.endpointGroupId, tenantId: business.tenantId },
        select: { id: true },
      });
      if (!group) throw new BadRequestException('Unknown computer group');
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + this.tokenTtlHours * 60 * 60 * 1000);

    const record = await this.prisma.deviceClaimToken.create({
      data: {
        tenantId: business.tenantId,
        token: tokenHash,
        expiresAt,
        endpointId: dto.endpointId ?? null,
        customerName: business.name,
        siteName: dto.siteName ?? null,
        description: dto.description ?? null,
        customerId: businessId,
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
        endpointGroupId: dto.endpointGroupId ?? null,
        createdById: actor.userId,
      },
    });

    await this.audit.log({
      tenantId: business.tenantId,
      customerId: businessId,
      actorId: actor.userId,
      actorIp: actor.ip,
      action: 'CLAIM_TOKEN_CREATED',
      resource: 'device_claim_token',
      resourceId: record.id,
      meta: {
        endpointId: dto.endpointId,
        description: dto.description,
        businessId,
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
      },
    });

    // The raw token is returned once so the caller can build the install URL;
    // only its hash is stored.
    return { ...record, token };
  }

  async listClaimTokens(actor: ActorContext, businessId?: string) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const scope = this.acl.resolveScope(actor, businessId);

    return this.prisma.deviceClaimToken.findMany({
      where: { ...(scope ? { customerId: scope } : {}) },
      include: {
        endpoint: { select: { id: true, name: true, hostname: true } },
        // Enough to show which business a token is bound to, nothing more.
        tenant: { select: { id: true } },
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
        throw new BadRequestException(`RustDesk ID ${dto.rustdeskId} is already registered to another Rem0te account`);
      }
      if (existingNode.tenantId === record.tenantId) {
        throw new BadRequestException(`RustDesk ID ${dto.rustdeskId} is already enrolled`);
      }
      // tenantId is null (unassigned)
      if (!record.endpointId) {
        // Adopt the unassigned node/endpoint into the token's business
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
      return {
        found: false,
        endpointId: endpoint.id,
        rustdeskRegistered: await this.peerRegisteredWithHbbs(dto.rustdeskId),
      };
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

    return {
      found: true,
      endpointId: node.endpointId,
      rotate,
      rustdeskRegistered: await this.peerRegisteredWithHbbs(dto.rustdeskId),
    };
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


  /**
   * Ask hbbs whether a peer has ever completed registration.
   *
   * This is the difference between "RustDesk is installed and configured" and
   * "RustDesk can actually be connected to". An endpoint can hold a perfect
   * config on disk, heartbeat us over 443 every 3 minutes, and still never
   * reach 21116 — which is indistinguishable from offline in the UI and lets
   * the installer report success for a machine nobody can connect to.
   *
   * hbbs (OSS) exposes no API, so its SQLite peer table is the only source of
   * truth. We shell out to the sqlite3 CLI rather than take a dependency:
   * node:sqlite does not exist on the Node 20 this service runs under, and
   * better-sqlite3 would mean a compiled native module for one read-only
   * query. The id is validated as digits before it reaches the SQL text.
   *
   * Returns null — never throws, never false — when the question cannot be
   * answered (hbbs on another host, file unreadable, sqlite3 absent, WAL
   * unreadable). Callers MUST treat null as "unknown", not as a failure:
   * refusing an install because we could not read a file would be worse than
   * the bug this exists to catch.
   */
  async peerRegisteredWithHbbs(rustdeskId: string): Promise<boolean | null> {
    if (!/^[0-9]{6,15}$/.test(rustdeskId)) return null;
    const dbPath =
      this.config.get<string>('RUSTDESK_DB_PATH') ??
      '/var/lib/rustdesk-server/db_v2.sqlite3';
    try {
      const { stdout } = await execFileAsync(
        'sqlite3',
        [`file:${dbPath}?mode=ro`, `SELECT 1 FROM peer WHERE id='${rustdeskId}' LIMIT 1;`],
        { timeout: 3000 },
      );
      return stdout.trim() === '1';
    } catch {
      return null;
    }
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

  async revokeClaimToken(actor: ActorContext, tokenId: string) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_REMOVE);
    const scope = this.acl.resolveScope(actor);

    const record = await this.prisma.deviceClaimToken.findFirst({
      where: { id: tokenId, ...(scope ? { customerId: scope } : {}) },
    });
    if (!record) throw new NotFoundException('Token not found');

    if (record.claimedAt) {
      throw new BadRequestException('Cannot revoke an already-claimed token');
    }

    await this.prisma.deviceClaimToken.delete({ where: { id: tokenId } });
    await this.audit.log({
      tenantId: record.tenantId, customerId: record.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_UNASSIGNED', resource: 'device_claim_token', resourceId: tokenId,
      meta: { revoked: true },
    });
    return { revoked: true };
  }
}
