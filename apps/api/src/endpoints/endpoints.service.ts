import {
  Injectable, NotFoundException, ConflictException,
  InternalServerErrorException, BadRequestException, Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, effectiveCapabilities } from '../rbac/capabilities';
import type { CreateEndpointDto, UpdateEndpointDto } from './dto/create-endpoint.dto';

/**
 * Computers.
 *
 * Business isolation rule for this whole file: nothing is read or written by
 * id until `acl.assertEndpointInScope()` has confirmed the computer belongs
 * to the caller's business, and every list query carries the scope filter.
 * Platform Admins are the only actors who see across businesses, and that is
 * decided inside AccessControlService, never here.
 */
@Injectable()
export class EndpointsService {
  private readonly logger = new Logger(EndpointsService.name);
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

  // ── Crypto helpers ────────────────────────────────────────────────────────

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

  /** Never let permanentPassword ciphertext past the service boundary. */
  private stripSecrets<T extends { rustdeskNode?: { permanentPassword?: string | null } | null } | null>(row: T): T {
    if (!row) return row;
    const node = row.rustdeskNode;
    if (node) {
      const { permanentPassword, ...rest } = node as { permanentPassword?: string | null } & Record<string, unknown>;
      (row as unknown as { rustdeskNode: unknown }).rustdeskNode = { ...rest, hasPassword: !!permanentPassword };
    }
    return row;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * The computers this person may actually connect to.
   *
   * Business Owners and Platform Admins see everything in scope. A Business
   * User sees the computers explicitly granted to them, plus any marked
   * COMPANY_WIDE inside their own business — and only if they hold
   * `computers:view`.
   */
  async myComputers(actor: ActorContext) {
    if (!this.acl.can(actor, CAP.COMPUTERS_VIEW)) return [];

    const rows = await this.prisma.endpoint.findMany({
      where: {
        status: 'ACTIVE',
        // Shared with the dashboard map so the two can never disagree about
        // who may see which computer.
        ...this.acl.endpointVisibilityWhere(actor),
      },
      orderBy: [{ isOnline: 'desc' }, { name: 'asc' }],
      include: {
        customer: { select: { id: true, name: true } },
        rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true, permanentPassword: true } },
      },
    });
    return rows.map((r) => this.stripSecrets(r));
  }

  async findConnected(actor: ActorContext) {
    const scope = this.acl.resolveScope(actor);
    const rows = await this.prisma.endpoint.findMany({
      where: { isOnline: true, status: 'ACTIVE', ...(scope ? { customerId: scope } : {}) },
      orderBy: { lastSeenAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
        rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true, permanentPassword: true } },
        tags: true,
      },
    });
    return rows.map((r) => this.stripSecrets(r));
  }

  async findAll(actor: ActorContext, params: {
    search?: string; businessId?: string; status?: string;
    tag?: string; platform?: string; page?: number; limit?: number;
  }) {
    // A Platform Admin may narrow to one business with ?businessId=;
    // anyone else asking for a business that is not theirs gets a 403 here.
    const scope = this.acl.resolveScope(actor, params.businessId);

    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      ...(scope ? { customerId: scope } : {}),
      // "unassigned" is a platform-admin-only view — a business can never own
      // a computer that belongs to no business.
      ...(!scope && params.businessId === 'null' ? { customerId: null } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.platform ? { platform: params.platform } : {}),
      ...(params.search ? {
        OR: [
          { name: { contains: params.search, mode: 'insensitive' } },
          { hostname: { contains: params.search, mode: 'insensitive' } },
          { ipAddress: { contains: params.search, mode: 'insensitive' } },
          { osVersion: { contains: params.search, mode: 'insensitive' } },
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

    return { endpoints: endpoints.map((e) => this.stripSecrets(e)), total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(actor: ActorContext, id: string) {
    await this.acl.assertEndpointInScope(actor, id);

    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id },
      include: {
        customer: true,
        site: true,
        endpointGroup: true,
        // The ciphertext is selected only to be collapsed into a boolean below.
        // Plaintext is reachable only through the audited password route.
        rustdeskNode: {
          select: {
            id: true, rustdeskId: true, hostname: true, platform: true,
            version: true, lastSeenAt: true, createdAt: true, permanentPassword: true,
          },
        },
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
    if (!endpoint) throw new NotFoundException('Computer not found');
    return this.stripSecrets(endpoint);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(actor: ActorContext, dto: CreateEndpointDto & { businessId?: string }) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_ADD);

    // The business a computer lands in is decided by the scope rule, never by
    // whatever id the client put in the body.
    const businessId = this.acl.requireScope(actor, dto.businessId ?? dto.customerId);
    const business = await this.prisma.customer.findUnique({
      where: { id: businessId },
      select: { id: true, tenantId: true },
    });
    if (!business) throw new NotFoundException('Business not found');

    // A site, if given, has to belong to the same business.
    if (dto.siteId) {
      const site = await this.prisma.site.findFirst({
        where: { id: dto.siteId, customerId: businessId }, select: { id: true },
      });
      if (!site) throw new BadRequestException('That site does not belong to this business');
    }

    const endpoint = await this.prisma.endpoint.create({
      data: {
        tenantId: business.tenantId,
        customerId: businessId,
        name: dto.name,
        description: dto.description,
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
          rustdeskNode: { create: { tenantId: business.tenantId, rustdeskId: dto.rustdeskId, platform: dto.platform } },
        } : {}),
      },
    });

    await this.audit.log({
      action: 'ENDPOINT_CREATED', actorId: actor.userId, actorIp: actor.ip,
      tenantId: business.tenantId, customerId: businessId,
      resource: 'endpoint', resourceId: endpoint.id, meta: { name: endpoint.name },
    });
    return endpoint;
  }

  async update(actor: ActorContext, id: string, dto: UpdateEndpointDto) {
    const existing = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    // Only a Platform Admin may move a computer between businesses.
    if (dto.customerId !== undefined && dto.customerId !== existing.customerId) {
      this.acl.assertPlatformAdmin(actor);
      if (dto.customerId) {
        const target = await this.prisma.customer.findUnique({
          where: { id: dto.customerId }, select: { id: true, tenantId: true },
        });
        if (!target) throw new NotFoundException('Target business not found');
      }
    }

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
        ...(dto.aiTimeline !== undefined ? { aiTimeline: dto.aiTimeline } : {}),
      },
    });

    await this.audit.log({
      action: 'ENDPOINT_UPDATED', actorId: actor.userId, actorIp: actor.ip,
      tenantId: existing.tenantId ?? undefined, customerId: existing.customerId ?? undefined,
      resource: 'endpoint', resourceId: id,
    });
    return endpoint;
  }

  async archive(actor: ActorContext, id: string) {
    const existing = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_REMOVE);

    const endpoint = await this.prisma.endpoint.update({ where: { id }, data: { status: 'ARCHIVED' } });
    // Revoke every standing grant — an archived computer nobody can reach is
    // the point of archiving it.
    await this.prisma.computerAccess.deleteMany({ where: { endpointId: id } });

    await this.audit.log({
      action: 'ENDPOINT_ARCHIVED', actorId: actor.userId, actorIp: actor.ip,
      tenantId: existing.tenantId ?? undefined, customerId: existing.customerId ?? undefined,
      resource: 'endpoint', resourceId: id,
    });
    return endpoint;
  }

  async addTag(actor: ActorContext, id: string, tag: string) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    try {
      await this.prisma.endpointTag.create({ data: { endpointId: id, tag } });
    } catch {
      throw new ConflictException('Tag already exists');
    }
  }

  async removeTag(actor: ActorContext, id: string, tag: string) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    await this.prisma.endpointTag.deleteMany({ where: { endpointId: id, tag } });
  }

  async addAlias(actor: ActorContext, id: string, alias: string, isPrimary = false) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    if (isPrimary) {
      await this.prisma.endpointAlias.updateMany({ where: { endpointId: id, isPrimary: true }, data: { isPrimary: false } });
    }
    return this.prisma.endpointAlias.create({ data: { endpointId: id, alias, isPrimary } });
  }

  async removeAlias(actor: ActorContext, id: string, aliasId: string) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    await this.prisma.endpointAlias.deleteMany({ where: { id: aliasId, endpointId: id } });
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  async setPassword(actor: ActorContext, id: string, password: string | null): Promise<void> {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const node = await this.prisma.rustdeskNode.findUnique({ where: { endpointId: id }, select: { id: true } });
    if (!node) throw new NotFoundException('No RustDesk node linked to this computer');
    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: { permanentPassword: password ? this.encryptPassword(password) : null },
    });
  }

  async getPassword(actor: ActorContext, id: string): Promise<string | null> {
    const endpoint = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const node = await this.prisma.rustdeskNode.findUnique({
      where: { endpointId: id }, select: { permanentPassword: true },
    });
    if (!node?.permanentPassword) return null;

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint', resourceId: id,
    });
    return this.decryptPassword(node.permanentPassword);
  }

  /**
   * Stage a credential rotation. A fresh password is generated, encrypted and
   * parked as `pendingPassword`; the endpoint applies it on its next
   * heartbeat and confirms with a digest. The old password stays valid until
   * that confirmation, so Connect keeps working throughout.
   */
  async rotateCredential(actor: ActorContext, endpointId: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, endpointId);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const node = await this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { id: true } });
    if (!node) throw new NotFoundException('No RustDesk node linked to this computer');

    const rnd = crypto.randomBytes(24).toString('base64')
      .replace(/[+/=]/g, '')
      .slice(0, 20);

    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: { pendingPassword: this.encryptPassword(rnd), pendingPasswordAt: new Date() },
    });
    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_CREDENTIAL_ROTATION_STAGED', resource: 'endpoint', resourceId: endpointId,
    });
    return { success: true, status: 'PENDING' };
  }

  /**
   * Called by the endpoint after it applied the pending password. It proves
   * success by returning the SHA-256 of the plaintext it applied.
   *
   * Unauthenticated by nature (the device speaks, not a user), so it is keyed
   * solely on the rustdeskId and can only ever promote a password the server
   * itself generated.
   */
  async confirmRotation(rustdeskId: string, passwordSha256: string) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, pendingPassword: true },
    });
    if (!node?.pendingPassword) return { confirmed: false, reason: 'no_pending' };

    let plain: string;
    try { plain = this.decryptPassword(node.pendingPassword); }
    catch { return { confirmed: false, reason: 'decrypt_failed' }; }

    const expected = crypto.createHash('sha256').update(plain).digest('hex');
    if (expected !== passwordSha256) return { confirmed: false, reason: 'digest_mismatch' };

    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: { permanentPassword: node.pendingPassword, pendingPassword: null, pendingPasswordAt: null },
    });

    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: node.endpointId }, select: { customerId: true },
    });
    await this.audit.log({
      tenantId: node.tenantId ?? undefined, customerId: endpoint?.customerId ?? undefined,
      action: 'ENDPOINT_CREDENTIAL_ROTATED', resource: 'endpoint', resourceId: node.endpointId,
    });
    return { confirmed: true };
  }

  /** Pending-rotation plaintext for the endpoint itself. Heartbeat only. */
  async getPendingRotationForEndpoint(rustdeskId: string): Promise<string | null> {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId }, select: { pendingPassword: true },
    });
    if (!node?.pendingPassword) return null;
    try { return this.decryptPassword(node.pendingPassword); }
    catch { return null; }
  }

  // ── Connecting ────────────────────────────────────────────────────────────

  /**
   * The single authorization decision behind every remote connection.
   *
   * Order matters: business scope first (can this actor see this computer at
   * all), then the connect capability, then the per-computer grant.
   */
  private async authorizeConnect(
    actor: ActorContext,
    endpointId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { id: true, customerId: true, tenantId: true, accessMode: true, status: true },
    });
    if (!endpoint) return { ok: false, reason: 'endpoint_not_found' };

    if (!actor.isPlatformAdmin) {
      if (!actor.businessId || endpoint.customerId !== actor.businessId) {
        return { ok: false, reason: 'wrong_business' };
      }
      // A disabled business cannot be connected into.
      const business = await this.prisma.customer.findUnique({
        where: { id: endpoint.customerId },
        select: { isActive: true, isArchived: true },
      });
      if (!business?.isActive || business.isArchived) return { ok: false, reason: 'business_disabled' };
    }

    if (endpoint.status === 'ARCHIVED') return { ok: false, reason: 'endpoint_archived' };

    if (!this.acl.can(actor, CAP.COMPUTERS_CONNECT)) {
      return { ok: false, reason: 'missing_connect_permission' };
    }

    // Business Owners and Platform Admins may reach any computer in scope.
    if (this.acl.isBusinessOwner(actor)) return { ok: true };

    const access = await this.prisma.computerAccess.findFirst({
      where: { endpointId, userId: actor.userId }, select: { id: true },
    });
    if (access) return { ok: true };

    if (endpoint.accessMode === 'COMPANY_WIDE' && endpoint.customerId === actor.businessId) {
      return { ok: true };
    }
    return { ok: false, reason: 'no_access' };
  }

  /**
   * Mint a short-lived, single-use ConnectionGrant. The browser only ever
   * holds the opaque token; the launcher redeems it over authenticated HTTPS
   * to obtain the actual RustDesk credentials.
   */
  async createConnectionGrant(actor: ActorContext, endpointId: string) {
    const authz = await this.authorizeConnect(actor, endpointId);
    if (!authz.ok) {
      await this.audit.log({
        tenantId: actor.tenantId ?? undefined, customerId: actor.businessId ?? undefined,
        actorId: actor.userId, actorIp: actor.ip,
        action: 'CONNECTION_GRANT_DENIED', resource: 'endpoint', resourceId: endpointId,
        meta: { denied: authz.reason },
      });
      // Deliberately indistinguishable from "does not exist" — probing another
      // business's ids must not reveal whether they are real.
      throw new NotFoundException('Computer not found');
    }

    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId }, select: { tenantId: true, customerId: true },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 90_000);

    const grant = await this.prisma.connectionGrant.create({
      data: {
        tokenHash,
        tenantId: endpoint?.tenantId ?? actor.tenantId!,
        userId: actor.userId,
        endpointId,
        expiresAt,
        createdByIp: actor.ip ?? null,
      },
      select: { id: true, expiresAt: true },
    });

    await this.audit.log({
      tenantId: endpoint?.tenantId ?? undefined, customerId: endpoint?.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'CONNECTION_GRANT_CREATED', resource: 'connection_grant', resourceId: grant.id,
      meta: { endpointId },
    });
    return { grantId: grant.id, token, expiresAt: grant.expiresAt };
  }

  /**
   * Redeem a grant. Re-runs the full authorization check — access may have
   * been revoked in the seconds between minting and redemption.
   */
  async redeemConnectionGrant(rawToken: string, actorIp: string | undefined) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const grant = await this.prisma.connectionGrant.findUnique({
      where: { tokenHash },
      include: {
        endpoint: {
          include: {
            rustdeskNode: { select: { rustdeskId: true, permanentPassword: true } },
            customer: { select: { id: true, name: true } },
          },
        },
        user: { select: { id: true, email: true, status: true, isPlatformAdmin: true } },
      },
    });
    if (!grant) throw new NotFoundException('Grant not found');
    if (grant.usedAt) throw new NotFoundException('Grant already used');
    if (grant.expiresAt < new Date()) throw new NotFoundException('Grant expired');
    if (grant.user.status !== 'ACTIVE') throw new NotFoundException('Authorization no longer valid');

    // Rebuild the grantee's live context from the database rather than
    // trusting anything recorded at mint time.
    const membership = await this.prisma.membership.findFirst({
      where: { userId: grant.userId, isActive: true },
      select: { customerId: true, capabilities: true, role: { select: { type: true } } },
    });
    const granteeActor: ActorContext = {
      userId: grant.userId,
      email: grant.user.email,
      tenantId: grant.tenantId,
      businessId: membership?.customerId ?? null,
      isPlatformAdmin: grant.user.isPlatformAdmin,
      roleType: membership?.role.type ?? null,
      // Recomputed through the same path every request uses.
      capabilities: effectiveCapabilities({
        isPlatformAdmin: grant.user.isPlatformAdmin,
        roleType: membership?.role.type ?? null,
        capabilities: membership?.capabilities ?? null,
      }),
      ip: actorIp,
    };

    const authz = await this.authorizeConnect(granteeActor, grant.endpointId);
    if (!authz.ok) {
      await this.audit.log({
        tenantId: grant.tenantId, customerId: grant.endpoint.customerId ?? undefined,
        actorId: grant.userId, actorIp,
        action: 'CONNECTION_GRANT_DENIED', resource: 'connection_grant', resourceId: grant.id,
        meta: { reason: authz.reason },
      });
      throw new NotFoundException('Authorization no longer valid');
    }

    const rdId = grant.endpoint.rustdeskNode?.rustdeskId;
    if (!rdId) throw new NotFoundException('Computer is not enrolled');
    const password = grant.endpoint.rustdeskNode?.permanentPassword
      ? this.decryptPassword(grant.endpoint.rustdeskNode.permanentPassword)
      : null;

    await this.prisma.connectionGrant.update({
      where: { id: grant.id },
      data: { usedAt: new Date(), usedByIp: actorIp ?? null },
    });
    await this.audit.log({
      tenantId: grant.tenantId, customerId: grant.endpoint.customerId ?? undefined,
      actorId: grant.userId, actorIp,
      action: 'CONNECTION_GRANT_REDEEMED', resource: 'connection_grant', resourceId: grant.id,
      meta: { endpointId: grant.endpointId },
    });

    return {
      rustdeskId: rdId,
      password,
      computer: {
        id: grant.endpoint.id,
        name: grant.endpoint.name,
        hostname: grant.endpoint.hostname,
        businessName: grant.endpoint.customer?.name ?? null,
      },
    };
  }

  /**
   * One-click Connect: returns the credentials the browser hands to the
   * launcher. Authorization is identical to the grant path.
   */
  async connectInfo(actor: ActorContext, endpointId: string) {
    const authz = await this.authorizeConnect(actor, endpointId);
    if (!authz.ok) {
      await this.audit.log({
        tenantId: actor.tenantId ?? undefined, customerId: actor.businessId ?? undefined,
        actorId: actor.userId, actorIp: actor.ip,
        action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint', resourceId: endpointId,
        meta: { denied: authz.reason },
      });
      throw new NotFoundException('Computer not found');
    }

    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      include: {
        rustdeskNode: { select: { rustdeskId: true, permanentPassword: true } },
        customer: { select: { id: true, name: true } },
      },
    });
    if (!endpoint?.rustdeskNode?.rustdeskId) {
      throw new NotFoundException('Computer is not yet enrolled to accept connections');
    }

    const password = endpoint.rustdeskNode.permanentPassword
      ? this.decryptPassword(endpoint.rustdeskNode.permanentPassword)
      : null;

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint', resourceId: endpointId,
      meta: { via: 'connect' },
    });

    // Record the connection as a session.
    //
    // Until now nothing did. The launcher promoted a session to CLIENT_OPENED,
    // but the browser path — which is the one people actually use — created no
    // session at all, so Recent Sessions only ever showed the ad-hoc records
    // typed in by hand, which then aged into FAILED because nothing completed
    // them either. Handing the credentials to a client IS the start of a
    // session, and that is what CLIENT_OPENED means on the launcher path too.
    //
    // Best-effort: a bookkeeping failure must never stop someone connecting.
    let sessionId: string | null = null;
    try {
      const s = await this.prisma.supportSession.create({
        data: {
          tenantId: endpoint.tenantId!,
          customerId: endpoint.customerId,
          technicianId: actor.userId,
          endpointId: endpoint.id,
          isAdHoc: false,
          status: 'CLIENT_OPENED',
          startedAt: new Date(),
        },
        select: { id: true },
      });
      sessionId = s.id;
    } catch (e) {
      this.logger.warn(`Could not record support session for ${endpointId}: ${(e as Error).message}`);
    }

    return {
      rustdeskId: endpoint.rustdeskNode.rustdeskId,
      password,
      hasPassword: !!password,
      sessionId,
      computer: {
        id: endpoint.id,
        name: endpoint.name,
        hostname: endpoint.hostname,
        businessName: endpoint.customer?.name ?? null,
      },
    };
  }

  // ── Per-computer access grants ────────────────────────────────────────────

  async listAccess(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    this.acl.assertCapability(actor, CAP.USERS_VIEW);

    return this.prisma.computerAccess.findMany({
      where: { endpointId },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async grantAccess(actor: ActorContext, endpointId: string, userId: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, endpointId);
    this.acl.assertCapability(actor, CAP.USERS_MANAGE);

    // The grantee must belong to the same business as the computer. Without
    // this a Business Owner could hand access to someone from elsewhere.
    const membership = await this.prisma.membership.findFirst({
      where: { userId, isActive: true, customerId: endpoint.customerId ?? '__none__' },
      select: { id: true, tenantId: true },
    });
    if (!membership) throw new NotFoundException('That user is not an active member of this business');

    const row = await this.prisma.computerAccess.upsert({
      where: { userId_endpointId: { userId, endpointId } },
      update: { grantedBy: actor.userId },
      create: { tenantId: membership.tenantId, endpointId, userId, grantedBy: actor.userId },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_ACCESS_GRANTED', resource: 'endpoint', resourceId: endpointId,
      meta: { userId },
    });
    return row;
  }

  async revokeAccess(actor: ActorContext, endpointId: string, userId: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, endpointId);
    this.acl.assertCapability(actor, CAP.USERS_MANAGE);

    await this.prisma.computerAccess.deleteMany({ where: { endpointId, userId } });
    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_ACCESS_REVOKED', resource: 'endpoint', resourceId: endpointId,
      meta: { userId },
    });
  }

  async setAccessMode(actor: ActorContext, endpointId: string, mode: 'ASSIGNED_USERS' | 'COMPANY_WIDE') {
    const endpoint = await this.acl.assertEndpointInScope(actor, endpointId);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const updated = await this.prisma.endpoint.update({
      where: { id: endpointId }, data: { accessMode: mode }, select: { id: true, accessMode: true },
    });
    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_UPDATED', resource: 'endpoint', resourceId: endpointId,
      meta: { accessMode: mode },
    });
    return updated;
  }

  // ── Enrollment plumbing ───────────────────────────────────────────────────

  async setRustdeskNode(
    tenantId: string,
    endpointId: string,
    rustdeskId: string,
    meta?: { platform?: string; version?: string; hostname?: string },
  ) {
    // A rustdeskId may only ever map to one computer, platform-wide.
    const dupe = await this.prisma.rustdeskNode.findFirst({ where: { rustdeskId, endpointId: { not: endpointId } } });
    if (dupe) throw new ConflictException('That RustDesk ID is already assigned to another computer');

    const existing = await this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { tenantId: true } });
    if (existing && existing.tenantId && existing.tenantId !== tenantId) {
      throw new ConflictException('RustDesk node is bound to a different account');
    }
    return this.prisma.rustdeskNode.upsert({
      where: { endpointId },
      create: { tenantId, endpointId, rustdeskId, ...meta },
      update: { rustdeskId, lastSeenAt: new Date(), ...meta },
    });
  }

  // ── AI timeline ───────────────────────────────────────────────────────────

  async generateTimeline(actor: ActorContext, id: string): Promise<{ text: string }> {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
        tags: true,
        aliases: true,
        noteRels: {
          include: { author: { select: { email: true } } },
          orderBy: { createdAt: 'asc' }, take: 30,
        },
        supportSessions: {
          orderBy: { createdAt: 'asc' }, take: 20,
          select: {
            createdAt: true, status: true, issueDescription: true,
            notes: true, disposition: true, duration: true,
          },
        },
      },
    });
    if (!endpoint) throw new NotFoundException('Computer not found');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new InternalServerErrorException('ANTHROPIC_API_KEY is not configured');

    const lines: string[] = [
      `Device: ${endpoint.name}`,
      `Hostname: ${endpoint.hostname ?? 'Unknown'}`,
      `Platform: ${endpoint.platform ?? 'Unknown'}`,
      `OS: ${endpoint.osVersion ?? 'Unknown'}`,
      `Status: ${endpoint.status}`,
      `Currently online: ${endpoint.isOnline ? 'Yes' : 'No'}`,
      `Last seen: ${endpoint.lastSeenAt ? endpoint.lastSeenAt.toISOString() : 'Never'}`,
      `Business: ${endpoint.customer?.name ?? 'Unassigned'}`,
      `Site: ${endpoint.site?.name ?? 'None'}`,
      `Tags: ${endpoint.tags.map((t) => t.tag).join(', ') || 'None'}`,
      `Enrolled: ${endpoint.createdAt.toISOString()}`,
    ];

    if (endpoint.noteRels.length > 0) {
      lines.push('\nNotes (oldest to newest):');
      for (const n of endpoint.noteRels) {
        lines.push(`  [${n.createdAt.toLocaleDateString()}] ${n.content}`);
      }
    }
    if (endpoint.supportSessions.length > 0) {
      lines.push('\nSupport session history:');
      for (const s of endpoint.supportSessions) {
        const parts = [`[${s.createdAt.toLocaleDateString()}] ${s.status}`];
        if (s.issueDescription) parts.push(`Issue: ${s.issueDescription}`);
        if (s.disposition) parts.push(`Resolution: ${s.disposition}`);
        if (s.duration) parts.push(`Duration: ${Math.round(s.duration / 60)}m`);
        lines.push('  ' + parts.join(' | '));
      }
    }

    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a technical support AI assistant. Based on the device information below, write a concise narrative summary (2–4 paragraphs) about this device: its current state, history, notable patterns, and anything a technician should know before working on it. Write in plain, direct prose — no bullet points, no headings, no markdown.\n\n${lines.join('\n')}`,
      }],
    });

    const block = message.content.find((b) => b.type === 'text');
    const text = block ? (block as Anthropic.TextBlock).text : '';

    await this.prisma.endpoint.update({ where: { id }, data: { aiTimeline: text } });
    return { text };
  }
}
