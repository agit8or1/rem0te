import {
  Injectable, NotFoundException, ConflictException,
  InternalServerErrorException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CANDIDATE_LIVE_MS } from '../enrollment/device-secret';
import { ConfigService } from '@nestjs/config';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, effectiveCapabilities } from '../rbac/capabilities';
import { AGENT_CONTRACT_VERSION, agentMeetsContract } from '../common/agent-contract';
import type { CreateEndpointDto, UpdateEndpointDto } from './dto/create-endpoint.dto';
import { EndpointInventoryService } from '../endpoint-inventory/endpoint-inventory.service';

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
    private readonly inventory: EndpointInventoryService,
  ) {
    const rawKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey) || rawKey.toLowerCase() === '0'.repeat(64)) {
      throw new Error('ENCRYPTION_KEY is missing or invalid — refusing to start. Set a 64-hex-char key.');
    }
    this.encKey = Buffer.from(rawKey, 'hex');
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  private encryptPassword(text: string): string {
    // 12 bytes is the GCM standard nonce length. The IV is stored with each
    // record, so anything written when this was 16 still decrypts.
    const iv = crypto.randomBytes(12);
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

    // Typing in a RustDesk ID is a Platform Admin action. A node created this
    // way has no device secret, and the installer's heartbeat fallback used to
    // bind the first secret it saw — so a Business Owner who learned another
    // business's machine ID (they get read out over the phone) could register
    // it first and receive that machine's secret and permanent password when
    // its real installer ran. Everyone else enrolls through a claim token,
    // which is the only path that proves the machine was handed an installer.
    if (dto.rustdeskId) {
      this.acl.assertPlatformAdmin(actor);
      if (!/^[0-9]{6,15}$/.test(dto.rustdeskId)) {
        throw new BadRequestException('A RustDesk ID is 6 to 15 digits');
      }
      const taken = await this.prisma.rustdeskNode.findUnique({
        where: { rustdeskId: dto.rustdeskId }, select: { id: true },
      });
      if (taken) throw new ConflictException('That RustDesk ID cannot be added');
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

    // A site must belong to the business the computer ends up in. Unchecked,
    // pointing a computer at another business's site id put that site's
    // contact details into findOne for this business.
    if (dto.siteId) {
      const targetBusiness = dto.customerId !== undefined ? dto.customerId : existing.customerId;
      const site = await this.prisma.site.findFirst({
        where: { id: dto.siteId, customerId: targetBusiness ?? '__none__' }, select: { id: true },
      });
      if (!site) throw new BadRequestException('That site does not belong to this business');
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

  /**
   * Undo an archive. Archiving is one click on the device page, and before
   * this there was no way back short of editing the database.
   *
   * Grants deleted by the archive are not restored — nothing recorded them —
   * so an ASSIGNED_USERS computer comes back reachable only by those who can
   * see every computer, and its users have to be assigned again.
   */
  async restore(actor: ActorContext, id: string) {
    const existing = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_REMOVE);
    if (existing.status !== 'ARCHIVED') throw new BadRequestException('This computer is not archived');

    // Back to wherever its enrolment had got to: a machine still waiting for
    // a business is PENDING_ENROLLMENT, everything else is ACTIVE.
    const status = existing.customerId ? 'ACTIVE' : 'PENDING_ENROLLMENT';
    const endpoint = await this.prisma.endpoint.update({ where: { id }, data: { status } });

    await this.audit.log({
      action: 'ENDPOINT_RESTORED', actorId: actor.userId, actorIp: actor.ip,
      tenantId: existing.tenantId ?? undefined, customerId: existing.customerId ?? undefined,
      resource: 'endpoint', resourceId: id, meta: { status },
    });
    return endpoint;
  }

  /**
   * Accept the new device secret a computer has been heartbeating with since
   * its bound one stopped matching. See EnrollmentService.recordCandidateSecret.
   *
   * This is the operator standing in for a claim token: the alternative is
   * re-running the installer at the machine, which is exactly what someone
   * cannot do when the machine they would connect to is the one locked out.
   * It refuses a candidate that is stale (the machine is not offering it now)
   * or conflicted (two different secrets were offered for this RustDesk ID).
   */
  async acceptDeviceSecret(actor: ActorContext, id: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const node = await this.prisma.rustdeskNode.findUnique({
      where: { endpointId: id },
      select: {
        id: true, candidateSecretHash: true, candidateSecretSeenAt: true,
        candidateSecretIp: true, candidateSecretConflict: true, candidatePassword: true,
      },
    });
    if (!node?.candidateSecretHash || !node.candidateSecretSeenAt) {
      throw new BadRequestException('This computer is not offering a new device secret');
    }
    if (Date.now() - node.candidateSecretSeenAt.getTime() >= CANDIDATE_LIVE_MS) {
      throw new BadRequestException(
        'The new device secret has not been seen recently. Make sure the computer is on, wait for its next heartbeat, and try again.',
      );
    }
    if (node.candidateSecretConflict) {
      throw new ConflictException(
        'More than one new device secret has been offered for this RustDesk ID, so it is not safe to accept either. ' +
        'Re-run the installer on the computer from an enrollment link made for it.',
      );
    }

    // Conditional on the candidate still being the one checked above, so a
    // heartbeat replacing it between the read and the write cannot slip a
    // different secret through.
    const r = await this.prisma.rustdeskNode.updateMany({
      where: { id: node.id, candidateSecretHash: node.candidateSecretHash, candidateSecretConflict: false },
      data: {
        agentSecretHash: node.candidateSecretHash,
        agentSecretSetAt: new Date(),
        candidateSecretHash: null, candidateSecretSeenAt: null, candidateSecretFirstAt: null,
        candidateSecretIp: null, candidateSecretConflict: false, candidatePassword: null,
        // The password the machine reported alongside this secret is the one
        // RustDesk is using now. Keeping the old one is what made Connect
        // answer "wrong password" after an accepted reinstall.
        ...(node.candidatePassword ? { permanentPassword: node.candidatePassword } : {}),
      },
    });
    if (r.count !== 1) throw new ConflictException('The offered secret changed while accepting it. Reload and try again.');

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_DEVICE_SECRET_ACCEPTED', resource: 'endpoint', resourceId: id,
      meta: { offeredFrom: node.candidateSecretIp, passwordUpdated: !!node.candidatePassword },
    });
    return { accepted: true, passwordUpdated: !!node.candidatePassword };
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

  /**
   * The per-computer half of authorizeConnect, for the operations that hand
   * out or replace a computer's credential. `computers:edit` alone is a
   * business-wide capability; without this, a Business User who had been
   * granted no access to a machine could still reveal its permanent password
   * and connect with it. Owners and Platform Admins reach everything in scope.
   */
  private async assertComputerReachable(actor: ActorContext, endpointId: string): Promise<void> {
    if (this.acl.isBusinessOwner(actor)) return;
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { id: endpointId }, select: { accessMode: true, customerId: true },
    });
    if (endpoint?.accessMode === 'COMPANY_WIDE' && endpoint.customerId === actor.businessId) return;
    const access = await this.prisma.computerAccess.findFirst({
      where: { endpointId, userId: actor.userId }, select: { id: true },
    });
    if (!access) throw new ForbiddenException('You have not been given access to this computer');
  }

  async setPassword(actor: ActorContext, id: string, password: string | null): Promise<void> {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    await this.assertComputerReachable(actor, id);

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
    await this.assertComputerReachable(actor, id);

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
    await this.assertComputerReachable(actor, endpointId);

    const node = await this.prisma.rustdeskNode.findUnique({
      where: { endpointId }, select: { id: true, agentSecretHash: true },
    });
    if (!node) throw new NotFoundException('No RustDesk node linked to this computer');
    // The staged password is handed to whoever heartbeats as this RustDesk ID.
    // Without a bound device secret that is anyone who knows the ID.
    if (!node.agentSecretHash) {
      throw new BadRequestException(
        'This computer has no device secret yet. Re-run its installer before rotating its password.',
      );
    }

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

  /** authorizeConnect for callers outside this service (the launcher). */
  async canConnect(actor: ActorContext, endpointId: string): Promise<boolean> {
    return (await this.authorizeConnect(actor, endpointId)).ok;
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

    // Conditional update rather than update: the earlier read-test-write let
    // two simultaneous redemptions of one grant both succeed, which is the one
    // thing a single-use credential must not do.
    const claimed = await this.prisma.connectionGrant.updateMany({
      where: { id: grant.id, usedAt: null },
      data: { usedAt: new Date(), usedByIp: actorIp ?? null },
    });
    if (claimed.count === 0) throw new NotFoundException('Grant already used');
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
    // COMPANY_WIDE grants every member of the business at once, so it needs
    // the same capability as granting one of them (grantAccess).
    this.acl.assertCapability(actor, CAP.USERS_MANAGE);

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
    // Thinking is always on for this model and counts toward max_tokens, so
    // the limit leaves room for it as well as the few paragraphs returned.
    // A safety-classifier decline is retried server-side on the model
    // Anthropic recommends for that category instead of coming back empty.
    const message = await anthropic.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: `You are a technical support AI assistant. Based on the device information below, write a concise narrative summary (2–4 paragraphs) about this device: its current state, history, notable patterns, and anything a technician should know before working on it. Write in plain, direct prose — no bullet points, no headings, no markdown.\n\n${lines.join('\n')}`,
      }],
    });

    // The reply can open with thinking blocks, so find the text by type. A
    // refusal from the whole fallback chain has none; keep the old summary.
    const block = message.content.find((b) => b.type === 'text');
    if (message.stop_reason === 'refusal' || !block) {
      throw new InternalServerErrorException('The AI summary could not be generated for this device');
    }
    const text = block.text;

    await this.prisma.endpoint.update({ where: { id }, data: { aiTimeline: text } });
    return { text };
  }

  // ── Inventory, updates and event logs ─────────────────────────────────────

  /**
   * Everything this computer has reported about itself.
   *
   * Also returns the RustDesk-client staleness, because "what needs updating
   * on this machine" is one question to the person asking it even though the
   * two answers come from different places: Windows Update pending patches are
   * collected by the agent, and the client version is compared against the
   * release this server serves.
   */
  async getInventory(actor: ActorContext, id: string) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);

    const [inventory, endpointRow, node, commands] = await Promise.all([
      this.inventory.get(id),
      this.prisma.endpoint.findUnique({ where: { id }, select: { agentVersion: true } }),
      this.prisma.rustdeskNode.findUnique({
        where: { endpointId: id },
        select: {
          version: true, updateTargetVersion: true, updateRequestedAt: true,
          agentSecretHash: true, reinstallRequestedAt: true, reinstallDispatchedAt: true,
          candidateSecretSeenAt: true, candidateSecretFirstAt: true,
          candidateSecretIp: true, candidateSecretConflict: true,
        },
      }),
      this.inventory.listCommands(id, 10),
    ]);

    return {
      inventory,
      rustdesk: {
        installedVersion: node?.version ?? null,
        // A staged upgrade the endpoint has not applied yet. Surfaced here so
        // the device page agrees with the Updates page instead of quietly
        // disagreeing with it.
        stagedVersion: node?.updateTargetVersion ?? null,
        stagedAt: node?.updateRequestedAt ?? null,
      },
      // The Rem0te agent, which is a different question from the RustDesk
      // client: it is what decides whether this machine can collect anything
      // at all.
      //
      // `outdated` is decided against AGENT_CONTRACT_VERSION, not against this
      // server's version. Those are different numbers, and comparing with the
      // platform version meant every release — a README fix included — marked
      // the whole fleet outdated next to a button offering a ~40 MB reinstall
      // per machine. `required` is surfaced so the UI can name the bar rather
      // than asking someone to compare two strings.
      agent: {
        version: endpointRow?.agentVersion ?? null,
        server: this.platformVersion(),
        required: AGENT_CONTRACT_VERSION,
        outdated: !agentMeetsContract(endpointRow?.agentVersion),
        reinstallPending: !!node?.reinstallRequestedAt,
        reinstallDispatched: !!node?.reinstallDispatchedAt,
      },
      // The one thing that explains an endpoint reporting nothing at all: its
      // installer predates device secrets, so the server takes nothing it
      // says. Without this the UI can only show empty cards and no reason.
      agentBound: !!node?.agentSecretHash,
      // The machine is heartbeating with a secret the server does not hold,
      // so nothing it sends is accepted. Without this the page shows a
      // computer that simply went offline.
      secretMismatch: node?.candidateSecretSeenAt
        ? {
            firstSeenAt: node.candidateSecretFirstAt,
            lastSeenAt: node.candidateSecretSeenAt,
            fromIp: node.candidateSecretIp,
            conflict: node.candidateSecretConflict,
            acceptable: !node.candidateSecretConflict &&
              Date.now() - node.candidateSecretSeenAt.getTime() < CANDIDATE_LIVE_MS,
          }
        : null,
      commands,
    };
  }

  /** This server's version — what a freshly generated installer reports. */
  private platformVersion(): string {
    try {
      const file = process.env.VERSION_FILE
        ?? path.join(process.env.PROJECT_ROOT ?? process.cwd(), 'version.json');
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Ask a computer to re-collect its inventory and re-check Windows Update.
   *
   * Nothing happens immediately: the commands sit in the queue until the
   * endpoint's next heartbeat, up to three minutes away. The UI says so rather
   * than spinning as though this were synchronous.
   */
  async requestInventoryRefresh(actor: ActorContext, id: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);

    const staged = [];
    for (const type of ['INVENTORY_REFRESH', 'UPDATE_SCAN'] as const) {
      const cmd = await this.inventory.stage({
        endpointId: id,
        tenantId: endpoint.tenantId, customerId: endpoint.customerId,
        type,
        requestedById: actor.userId,
      });
      if (cmd) staged.push({ id: cmd.id, type: cmd.type });
    }

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_INVENTORY_REFRESH_REQUESTED',
      resource: 'endpoint', resourceId: id,
    });

    return { staged };
  }

  /**
   * Ask a computer for a slice of one of its Windows event logs.
   *
   * Audited unconditionally, and with the query in the metadata. Someone
   * reading a customer's Security log is a thing that has to be answerable
   * after the fact — which log, how far back, and who asked.
   */
  async requestEventLog(actor: ActorContext, id: string, params: Record<string, unknown>) {
    const endpoint = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EVENT_LOGS);

    // Throws on an unknown log name or an out-of-range bound before anything
    // is written, so a rejected request leaves no row behind.
    const validated = this.inventory.validateParams('EVENT_LOG_QUERY', params);

    const cmd = await this.inventory.stage({
      endpointId: id,
      tenantId: endpoint.tenantId, customerId: endpoint.customerId,
      type: 'EVENT_LOG_QUERY',
      params,
      requestedById: actor.userId,
    });

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_EVENT_LOG_REQUESTED',
      resource: 'endpoint', resourceId: id,
      meta: { ...validated, commandId: cmd?.id },
    });

    if (!cmd) throw new InternalServerErrorException('Could not queue the request');
    return { commandId: cmd.id, status: cmd.status };
  }

  /**
   * Ask a computer to re-run its installer.
   *
   * This is the only way to upgrade the *agent* on a machine whose RustDesk
   * client is already current: `requestRustdeskUpdate` compares versions and
   * skips anything on the latest client, which is right for its purpose and
   * leaves the agent stuck at whatever the last install left behind.
   *
   * Re-running is idempotent and non-destructive — the installer keeps the
   * machine's server configuration, its permanent password and its enrolment,
   * and replaces the heartbeat script. It does pull the client binary again,
   * so it is not free; the endpoint's own 30-minute floor stops a stuck
   * request turning into a download loop.
   *
   * COMPUTERS_EDIT, not COMPUTERS_VIEW: unlike an inventory refresh this
   * installs software on somebody's machine.
   */
  async requestAgentReinstall(actor: ActorContext, id: string) {
    const endpoint = await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);

    const node = await this.prisma.rustdeskNode.findUnique({
      where: { endpointId: id },
      select: { id: true, agentSecretHash: true, reinstallRequestedAt: true },
    });
    if (!node) throw new NotFoundException('No RustDesk node linked to this computer');

    // The heartbeat only hands work to an endpoint that authenticated with its
    // device secret, so staging this for an unbound machine would look like it
    // worked and do nothing at all — which is precisely the trap the RustDesk
    // staging fell into, leaving one endpoint advertising a pending upgrade for
    // three weeks. Refuse instead, and say what the operator has to do.
    if (!node.agentSecretHash) {
      throw new BadRequestException(
        'This computer has never authenticated with a device secret, so the server cannot ' +
        'ask it to do anything. Re-run the installer on the machine itself once; after that ' +
        'it can be reinstalled from here.',
      );
    }

    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: {
        reinstallRequestedAt: new Date(),
        reinstallRequestedBy: actor.userId ?? null,
        // Cleared so a repeat request is dispatched again rather than being
        // treated as one already satisfied.
        reinstallDispatchedAt: null,
      },
    });

    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_AGENT_REINSTALL_REQUESTED', resource: 'endpoint', resourceId: id,
      meta: { requeued: !!node.reinstallRequestedAt },
    });

    return { status: 'PENDING' };
  }

  /**
   * The last event-log query run against this computer, whoever ran it.
   *
   * Same capability as making the request: this returns log contents, so
   * gating it on `computers:view` would mean the capability only controlled
   * who could ask, not who could read the answer.
   */
  async latestEventLog(actor: ActorContext, id: string) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EVENT_LOGS);
    return this.inventory.latestEventLog(id);
  }

  /**
   * Poll one command.
   *
   * An EVENT_LOG_QUERY result contains log contents, so this is gated on the
   * same capability that could ask for it — not on `computers:view`. Otherwise
   * the capability would only control who can make the request, and anyone who
   * could see the computer could read the answer.
   */
  async getCommand(actor: ActorContext, id: string, commandId: string) {
    await this.acl.assertEndpointInScope(actor, id);
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);

    const cmd = await this.inventory.getCommand(id, commandId);
    if (!cmd) throw new NotFoundException('Request not found');
    if (cmd.type === 'EVENT_LOG_QUERY') {
      this.acl.assertCapability(actor, CAP.COMPUTERS_EVENT_LOGS);
    }
    return cmd;
  }

}
