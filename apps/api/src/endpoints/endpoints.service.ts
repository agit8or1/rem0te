import {
  Injectable, NotFoundException, ConflictException, InternalServerErrorException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
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
    const rawKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey) || rawKey.toLowerCase() === '0'.repeat(64)) {
      throw new Error('ENCRYPTION_KEY is missing or invalid — refusing to start. Set a 64-hex-char key.');
    }
    this.encKey = Buffer.from(rawKey, 'hex');
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
    const node = await this.prisma.rustdeskNode.findFirst({
      where: { endpointId: id, tenantId },
      select: { id: true },
    });
    if (!node) throw new NotFoundException('No RustDesk node linked to this endpoint');
    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: { permanentPassword: password ? this.encryptPassword(password) : null },
    });
  }

  async getPassword(tenantId: string, id: string, actorId: string, actorIp?: string): Promise<string | null> {
    await this.assertOwnership(tenantId, id);
    const node = await this.prisma.rustdeskNode.findFirst({
      where: { endpointId: id, tenantId },
      select: { permanentPassword: true },
    });
    if (!node?.permanentPassword) return null;
    await this.audit.log({
      tenantId,
      actorId,
      actorIp,
      action: 'ENDPOINT_PASSWORD_REVEALED',
      resource: 'endpoint',
      resourceId: id,
    });
    return this.decryptPassword(node.permanentPassword);
  }

  // Employee-facing: computers the given user is authorized to connect to.
  // Includes: explicit ComputerAccess rows (assigned users) + endpoints whose
  // accessMode is COMPANY_WIDE and belong to a customer the user is a member of.
  // Never returns computers from other tenants; never returns the encrypted password.
  async myComputers(tenantId: string, userId: string) {
    // Which customers is this user linked to via their membership?
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId, isActive: true },
      select: { customerId: true },
    });

    const wideCustomerIds = membership?.customerId ? [membership.customerId] : [];

    const rows = await this.prisma.endpoint.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [
          { computerAccess: { some: { userId } } },
          ...(wideCustomerIds.length > 0
            ? [{ accessMode: 'COMPANY_WIDE' as const, customerId: { in: wideCustomerIds } }]
            : []),
        ],
      },
      orderBy: [{ isOnline: 'desc' }, { name: 'asc' }],
      include: {
        customer: { select: { id: true, name: true } },
        rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true, permanentPassword: true } },
      },
    });
    return rows.map((r) => this.stripSecrets(r));
  }

  async findConnected(tenantId: string) {
    const rows = await this.prisma.endpoint.findMany({
      where: { tenantId, isOnline: true, status: 'ACTIVE' },
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

  // Never expose permanentPassword ciphertext beyond the service boundary.
  // Replace it with a boolean `hasPassword` so the UI can render the key icon.
  private stripSecrets<T extends { rustdeskNode?: { permanentPassword?: string | null } | null } | null>(row: T): T {
    if (!row) return row;
    const node = row.rustdeskNode;
    if (node) {
      const { permanentPassword, ...rest } = node as { permanentPassword?: string | null } & Record<string, unknown>;
      (row as unknown as { rustdeskNode: unknown }).rustdeskNode = { ...rest, hasPassword: !!permanentPassword };
    }
    return row;
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

    return { endpoints: endpoints.map((e) => this.stripSecrets(e)), total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(tenantId: string, id: string) {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id, tenantId },
      include: {
        customer: true,
        site: true,
        endpointGroup: true,
        // permanentPassword ciphertext is selected but stripped below into a boolean.
        // The plaintext is only reachable through the dedicated audited GET /endpoints/:id/password.
        rustdeskNode: {
          select: {
            id: true,
            rustdeskId: true,
            hostname: true,
            platform: true,
            version: true,
            lastSeenAt: true,
            createdAt: true,
            permanentPassword: true,
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
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return this.stripSecrets(endpoint);
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
        ...(dto.aiTimeline !== undefined ? { aiTimeline: dto.aiTimeline } : {}),
      },
    });
    await this.audit.log({ action: 'ENDPOINT_UPDATED', actorId, tenantId, resource: 'endpoint', resourceId: id });
    return endpoint;
  }

  async generateTimeline(tenantId: string, id: string): Promise<{ text: string }> {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id, tenantId },
      include: {
        customer: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
        tags: true,
        aliases: true,
        noteRels: {
          include: { author: { select: { email: true } } },
          orderBy: { createdAt: 'asc' },
          take: 30,
        },
        supportSessions: {
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: {
            createdAt: true,
            status: true,
            issueDescription: true,
            notes: true,
            disposition: true,
            duration: true,
          },
        },
      },
    });
    if (!endpoint) throw new NotFoundException('Endpoint not found');

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
      `Customer: ${endpoint.customer?.name ?? 'Unassigned'}`,
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

    const text = message.content.find((b) => b.type === 'text')
      ? (message.content.find((b) => b.type === 'text') as Anthropic.TextBlock).text
      : '';

    await this.prisma.endpoint.update({
      where: { id },
      data: { aiTimeline: text },
    });

    return { text };
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
    // Global uniqueness check: a rustdeskId may only be tied to one endpoint anywhere.
    const dupe = await this.prisma.rustdeskNode.findFirst({ where: { rustdeskId, endpointId: { not: endpointId } } });
    if (dupe) throw new ConflictException('RustDesk ID already assigned to another endpoint');
    // Defensive: if a rustdeskNode already exists for this endpointId with a different tenantId,
    // do not overwrite it — that would indicate a corrupted tenant binding.
    const existing = await this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { tenantId: true } });
    if (existing && existing.tenantId && existing.tenantId !== tenantId) {
      throw new ConflictException('RustDesk node is bound to a different tenant');
    }
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

  // Create a short-lived, single-use ConnectionGrant the browser can hand to
  // the launcher. Grant lifetime = 90 s. Server verifies ComputerAccess (or
  // COMPANY_WIDE + membership) before minting. The grant is redeemed via
  // POST /grants/:token/redeem which returns the actual RustDesk credentials
  // over authenticated HTTPS. This keeps the permanent password off the
  // browser process.
  async createConnectionGrant(
    tenantId: string,
    userId: string,
    endpointId: string,
    actorIp: string | undefined,
    actor: { isPlatformAdmin?: boolean; roleType?: string | null },
  ) {
    const authz = await this.authorizeConnect(tenantId, userId, endpointId, actor);
    if (!authz.ok) {
      await this.audit.log({
        tenantId, actorId: userId, actorIp,
        action: 'ENDPOINT_PASSWORD_REVEALED',
        resource: 'endpoint', resourceId: endpointId,
        meta: { denied: authz.reason },
      });
      throw new NotFoundException('Computer not found');
    }
    const { randomBytes, createHash } = await import('crypto');
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 90_000);
    const grant = await this.prisma.connectionGrant.create({
      data: { tokenHash, tenantId, userId, endpointId, expiresAt, createdByIp: actorIp ?? null },
      select: { id: true, expiresAt: true },
    });
    await this.audit.log({
      tenantId, actorId: userId, actorIp,
      action: 'CONNECTION_GRANT_CREATED',
      resource: 'connection_grant', resourceId: grant.id,
      meta: { endpointId },
    });
    return { grantId: grant.id, token, expiresAt: grant.expiresAt };
  }

  // Redeem a ConnectionGrant. Verifies token, freshness, single-use, and
  // re-checks that the user still has access. Returns the actual credentials.
  async redeemConnectionGrant(rawToken: string, actorIp: string | undefined) {
    const { createHash } = await import('crypto');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const grant = await this.prisma.connectionGrant.findUnique({
      where: { tokenHash },
      include: {
        endpoint: {
          include: {
            rustdeskNode: { select: { rustdeskId: true, permanentPassword: true } },
            customer: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!grant) throw new NotFoundException('Grant not found');
    if (grant.usedAt) throw new NotFoundException('Grant already used');
    if (grant.expiresAt < new Date()) throw new NotFoundException('Grant expired');

    // Re-verify authorization: user may have been disabled or access revoked
    // between grant creation and redemption.
    const authz = await this.authorizeConnect(grant.tenantId, grant.userId, grant.endpointId, { isPlatformAdmin: false, roleType: null });
    if (!authz.ok) {
      await this.audit.log({
        tenantId: grant.tenantId, actorId: grant.userId, actorIp,
        action: 'CONNECTION_GRANT_DENIED',
        resource: 'connection_grant', resourceId: grant.id,
        meta: { reason: authz.reason },
      });
      throw new NotFoundException('Authorization no longer valid');
    }

    const rdId = grant.endpoint.rustdeskNode?.rustdeskId;
    if (!rdId) throw new NotFoundException('Computer not enrolled');
    const password = grant.endpoint.rustdeskNode?.permanentPassword
      ? this.decryptPassword(grant.endpoint.rustdeskNode.permanentPassword)
      : null;

    await this.prisma.connectionGrant.update({
      where: { id: grant.id },
      data: { usedAt: new Date(), usedByIp: actorIp ?? null },
    });
    await this.audit.log({
      tenantId: grant.tenantId, actorId: grant.userId, actorIp,
      action: 'CONNECTION_GRANT_REDEEMED',
      resource: 'connection_grant', resourceId: grant.id,
      meta: { endpointId: grant.endpointId },
    });
    return {
      rustdeskId: rdId,
      password,
      computer: {
        id: grant.endpoint.id,
        name: grant.endpoint.name,
        hostname: grant.endpoint.hostname,
        customerName: grant.endpoint.customer?.name ?? null,
      },
    };
  }

  private async authorizeConnect(
    tenantId: string,
    userId: string,
    endpointId: string,
    actor: { isPlatformAdmin?: boolean; roleType?: string | null },
  ): Promise<{ ok: true; endpoint: { customerId: string | null; accessMode: string } } | { ok: false; reason: string }> {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, tenantId },
      select: { id: true, customerId: true, accessMode: true, status: true },
    });
    if (!endpoint) return { ok: false, reason: 'endpoint_not_found' };
    if (endpoint.status === 'ARCHIVED' || endpoint.status === 'REVOKED' as never) {
      return { ok: false, reason: 'endpoint_' + endpoint.status.toLowerCase() };
    }

    const isMgmt = actor.isPlatformAdmin === true ||
      actor.roleType === 'TENANT_OWNER' ||
      actor.roleType === 'TENANT_ADMIN';
    if (isMgmt) return { ok: true, endpoint };

    const access = await this.prisma.computerAccess.findFirst({
      where: { endpointId, userId }, select: { id: true },
    });
    if (access) return { ok: true, endpoint };
    if (endpoint.accessMode === 'COMPANY_WIDE' && endpoint.customerId) {
      const m = await this.prisma.membership.findFirst({
        where: { tenantId, userId, isActive: true, customerId: endpoint.customerId },
        select: { id: true },
      });
      if (m) return { ok: true, endpoint };
    }
    return { ok: false, reason: 'no_access' };
  }

  // Employee "click Connect" flow. Verifies the caller is authorized for this
  // computer (via ComputerAccess or COMPANY_WIDE + membership), audits the
  // reveal, and returns { rustdeskId, password } so the browser can populate
  // RustDesk's clipboard-based prompt.
  //
  // No admin permission required — authorization comes from ComputerAccess.
  async connectInfo(
    tenantId: string,
    userId: string,
    endpointId: string,
    actorIp: string | undefined,
    actor: { isPlatformAdmin?: boolean; roleType?: string | null },
  ) {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, tenantId },
      include: {
        rustdeskNode: { select: { rustdeskId: true, permanentPassword: true } },
        customer: { select: { id: true, name: true } },
      },
    });
    if (!endpoint) throw new NotFoundException('Computer not found');
    if (!endpoint.rustdeskNode?.rustdeskId) {
      throw new NotFoundException('Computer is not yet enrolled to accept connections');
    }

    const isMgmt =
      actor.isPlatformAdmin === true ||
      actor.roleType === 'TENANT_OWNER' ||
      actor.roleType === 'TENANT_ADMIN';
    if (!isMgmt) {
      const access = await this.prisma.computerAccess.findFirst({
        where: { endpointId, userId },
        select: { id: true },
      });
      let authorized = !!access;
      if (!authorized && endpoint.accessMode === 'COMPANY_WIDE' && endpoint.customerId) {
        const m = await this.prisma.membership.findFirst({
          where: { tenantId, userId, isActive: true, customerId: endpoint.customerId },
          select: { id: true },
        });
        authorized = !!m;
      }
      if (!authorized) {
        await this.audit.log({
          tenantId, actorId: userId, actorIp,
          action: 'ENDPOINT_PASSWORD_REVEALED',
          resource: 'endpoint', resourceId: endpointId,
          meta: { denied: 'no_access' },
        });
        throw new NotFoundException('Computer not found');
      }
    }

    const password = endpoint.rustdeskNode.permanentPassword
      ? this.decryptPassword(endpoint.rustdeskNode.permanentPassword)
      : null;

    await this.audit.log({
      tenantId, actorId: userId, actorIp,
      action: 'ENDPOINT_PASSWORD_REVEALED',
      resource: 'endpoint', resourceId: endpointId,
      meta: { via: 'connect' },
    });

    return {
      rustdeskId: endpoint.rustdeskNode.rustdeskId,
      password,
      hasPassword: !!password,
      computer: {
        id: endpoint.id,
        name: endpoint.name,
        hostname: endpoint.hostname,
        customerName: endpoint.customer?.name ?? null,
      },
    };
  }

  // Stage a credential rotation. Generates a fresh high-entropy password,
  // encrypts it, and stores it as `pendingPassword` on the RustdeskNode.
  // The endpoint picks it up on its next /enrollment/heartbeat response and
  // applies it via `rustdesk.exe --password`, then POSTs to
  // /enrollment/confirm-rotation with the digest of the new password so the
  // server knows the endpoint actually applied it. Only then does the server
  // swap `permanentPassword` <- `pendingPassword` and clear pending.
  //
  // Until confirmation the OLD password remains active so Connect keeps
  // working. On failure the operator can call rotate again.
  async rotateCredential(tenantId: string, endpointId: string, actorId: string) {
    await this.assertOwnership(tenantId, endpointId);
    const node = await this.prisma.rustdeskNode.findFirst({
      where: { endpointId, tenantId }, select: { id: true },
    });
    if (!node) throw new NotFoundException('No RustDesk node linked to this computer');

    const rnd = crypto.randomBytes(24).toString('base64')
      .replace(/[+/=]/g, '')  // URL-safe, no padding
      .slice(0, 20);
    const encrypted = this.encryptPassword(rnd);

    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: { pendingPassword: encrypted, pendingPasswordAt: new Date() },
    });
    await this.audit.log({
      tenantId, actorId,
      action: 'ENDPOINT_CREDENTIAL_ROTATION_STAGED',
      resource: 'endpoint', resourceId: endpointId,
    });
    return { success: true, status: 'PENDING' };
  }

  // Called by the endpoint (during heartbeat) after applying the pending
  // password. The endpoint proves it succeeded by sending back the SHA-256
  // of the applied plaintext; we compare against the pending ciphertext's
  // decryption to swap it into place.
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

  // Return the pending-rotation plaintext for the endpoint to apply. Only
  // used in the /enrollment/heartbeat response — never in a browser API.
  async getPendingRotationForEndpoint(rustdeskId: string): Promise<string | null> {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId }, select: { pendingPassword: true },
    });
    if (!node?.pendingPassword) return null;
    try { return this.decryptPassword(node.pendingPassword); }
    catch { return null; }
  }

  // ── ComputerAccess management ─────────────────────────────────────────────

  async listAccess(tenantId: string, endpointId: string) {
    await this.assertOwnership(tenantId, endpointId);
    return this.prisma.computerAccess.findMany({
      where: { endpointId, tenantId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async grantAccess(tenantId: string, endpointId: string, userId: string, actorId: string) {
    await this.assertOwnership(tenantId, endpointId);
    // The user must actually be a member of this tenant.
    const membership = await this.prisma.membership.findFirst({
      where: { tenantId, userId, isActive: true },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException('User is not an active member of this tenant');

    const row = await this.prisma.computerAccess.upsert({
      where: { userId_endpointId: { userId, endpointId } },
      update: { grantedBy: actorId },
      create: { tenantId, endpointId, userId, grantedBy: actorId },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
    await this.audit.log({
      tenantId, actorId,
      action: 'ENDPOINT_ACCESS_GRANTED',
      resource: 'endpoint',
      resourceId: endpointId,
      meta: { userId },
    });
    return row;
  }

  async revokeAccess(tenantId: string, endpointId: string, userId: string, actorId: string) {
    await this.assertOwnership(tenantId, endpointId);
    await this.prisma.computerAccess.deleteMany({ where: { endpointId, userId, tenantId } });
    await this.audit.log({
      tenantId, actorId,
      action: 'ENDPOINT_ACCESS_REVOKED',
      resource: 'endpoint',
      resourceId: endpointId,
      meta: { userId },
    });
  }

  async setAccessMode(tenantId: string, endpointId: string, mode: 'ASSIGNED_USERS' | 'COMPANY_WIDE', actorId: string) {
    await this.assertOwnership(tenantId, endpointId);
    const updated = await this.prisma.endpoint.update({
      where: { id: endpointId },
      data: { accessMode: mode },
      select: { id: true, accessMode: true },
    });
    await this.audit.log({
      tenantId, actorId,
      action: 'ENDPOINT_UPDATED',
      resource: 'endpoint',
      resourceId: endpointId,
      meta: { accessMode: mode },
    });
    return updated;
  }
}
