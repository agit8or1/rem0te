import { UpdateTrustService } from '../update-trust/update-trust.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { assertFresh } from '../security-controls/review';
import { UNASSIGNED_WHERE } from '../common/unassigned';
import { keyState } from './deployment-key';
import { MappingCreate, normaliseValue, suggest, type MappingRow, type PoolFacts } from './mapping';

/** At most this many computers per assign or forget request. */
export const MAX_ADOPT = 200;

const id = z.string().regex(/^[a-z0-9]{20,40}$/, 'an id');
const Adopt = z.object({
  endpointIds: z.array(id).min(1).max(MAX_ADOPT),
  businessId: id,
  siteId: id.nullish(),
  groupIds: z.array(id).max(10).default([]),
  // The rule whose suggestion was accepted, recorded with each adoption.
  mappingId: id.nullish(),
}).strict();
const Forget = z.object({ endpointIds: z.array(id).min(1).max(MAX_ADOPT) }).strict();

const bad = (code: string, e: z.ZodError) =>
  new BadRequestException({ code, message: e.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });

export type AdoptResult = { endpointId: string; result: 'adopted' | 'not_unassigned' } | { endpointId: string; result: 'forgotten' | 'in_use' };

/**
 * The unassigned pool (0.57, check-security-invariants §70). Platform Admin
 * only, every method.
 *
 * - list: each pooled computer's identification and hardware, how it arrived
 *   (heartbeat, install script, or which deployment key), the address the
 *   server saw it from, and a SUGGESTED business and site from the explicitly
 *   configured rules (mapping.ts) with the rule that matched. Never who is
 *   signed in to it.
 * - adopt: one or many computers into one business and site (and static
 *   groups). Fresh sign-in (`devices.adopt`) after every input check; then per
 *   computer, in one transaction, a conditional write that only moves a
 *   computer that is STILL unassigned, its RustDesk node's tenant, the group
 *   memberships and an ENDPOINT_ADOPTED audit row naming the approver, the
 *   state before and after, the deployment key and the rule used.
 * - forget: delete pooled junk, the same way (conditional, audited).
 * - rules: list, add (fresh sign-in, `adoption.mappings`), remove.
 */
@Injectable()
export class AdoptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly updateTrust: UpdateTrustService,
  ) {}

  // ── The pool ──────────────────────────────────────────────────────────────

  async list(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    const [eps, rules] = await Promise.all([
      this.prisma.endpoint.findMany({
        where: { AND: [UNASSIGNED_WHERE, { status: { not: 'ARCHIVED' } }] },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          id: true, name: true, hostname: true, platform: true, osVersion: true, ipAddress: true, sourceIp: true,
          arrivedVia: true, deploymentKeyId: true, createdAt: true, lastSeenAt: true, isOnline: true, status: true,
          agentVersion: true, updateChannel: true, agentSha256: true, signedSeenAt: true, macAddress: true, serialNumber: true,
          rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true, agentSecretHash: true, version: true } },
          // Hardware and identification only. Not loggedOnUser: who is signed
          // in says nothing about whose computer it is, and is never a rule.
          inventory: {
            select: {
              manufacturer: true, model: true, serialNumber: true, chassisType: true, osCaption: true, osBuild: true, osArch: true,
              domain: true, cpuModel: true, cpuCores: true, cpuThreads: true, memoryTotalMb: true, systemDiskTotalMb: true, collectedAt: true,
            },
          },
          deploymentKey: { select: { id: true, name: true, customerId: true, siteId: true, mode: true, keyHint: true } },
        },
      }),
      this.prisma.adoptionMapping.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    ]);

    const served = this.updateTrust.servedAgent();
    const computers = eps.map((e) => {
      const facts: PoolFacts = { deploymentKeyId: e.deploymentKeyId, domain: e.inventory?.domain ?? null, sourceIp: e.sourceIp, hostname: e.hostname ?? e.name };
      const s = suggest(facts, rules as MappingRow[], e.deploymentKey ? { keyId: e.deploymentKey.id, customerId: e.deploymentKey.customerId, siteId: e.deploymentKey.siteId } : null);
      const { rustdeskNode: node, agentSha256: _sha, signedSeenAt: _seen, ...rest } = e;
      return {
        ...rest,
        // 0.70.1: what the page shows; agentVersion stays the recorded label.
        agentVersionView: this.updateTrust.agentVersionOf(e, served),
        rustdeskId: node?.rustdeskId ?? null,
        rustdeskVersion: node?.version ?? null,
        nodeLastSeenAt: node?.lastSeenAt ?? null,
        // Whether the computer proved a device secret, never the secret.
        agentBound: !!node?.agentSecretHash,
        suggestion: s.suggestion, matches: s.matches, conflict: s.conflict,
      };
    });
    const ids = new Set<string>();
    const sites = new Set<string>();
    for (const c of computers) for (const m of c.matches) { ids.add(m.customerId); if (m.siteId) sites.add(m.siteId); }
    for (const c of computers) if (c.deploymentKey) ids.add(c.deploymentKey.customerId);
    const [bs, ss] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
      this.prisma.site.findMany({ where: { id: { in: [...sites] } }, select: { id: true, name: true } }),
    ]);
    return {
      computers,
      businesses: Object.fromEntries(bs.map((b) => [b.id, b.name])),
      sites: Object.fromEntries(ss.map((s) => [s.id, s.name])),
    };
  }

  async adopt(actor: ActorContext, raw: unknown, freshMethod: string | null, via: 'single' | 'bulk' = 'bulk'): Promise<{ results: AdoptResult[] }> {
    this.acl.assertPlatformAdmin(actor);
    const parsed = Adopt.safeParse(raw);
    if (!parsed.success) throw bad('INVALID_ADOPTION', parsed.error);
    const dto = parsed.data;
    if (new Set(dto.endpointIds).size !== dto.endpointIds.length) throw new BadRequestException({ code: 'INVALID_ADOPTION', message: 'Each computer once.' });

    const business = await this.prisma.customer.findFirst({ where: { id: dto.businessId, isArchived: false }, select: { id: true, tenantId: true, name: true } });
    if (!business) throw new NotFoundException('Business not found');
    let siteId: string | null = null;
    if (dto.siteId) {
      const site = await this.prisma.site.findFirst({ where: { id: dto.siteId, customerId: business.id, isActive: true }, select: { id: true } });
      if (!site) throw new BadRequestException({ code: 'UNKNOWN_SITE', message: 'Unknown site for this business' });
      siteId = site.id;
    }
    const groupIds = [...new Set(dto.groupIds)];
    if (groupIds.length) {
      const groups = await this.prisma.endpointGroup.findMany({
        where: { id: { in: groupIds }, kind: 'STATIC', OR: [{ customerId: business.id }, { customerId: null, tenantId: business.tenantId }] },
        select: { id: true },
      });
      if (groups.length !== groupIds.length) throw new BadRequestException({ code: 'UNKNOWN_GROUP', message: 'Every group must be a static group of this business.' });
    }
    let mappingId: string | null = null;
    if (dto.mappingId) {
      const m = await this.prisma.adoptionMapping.findUnique({ where: { id: dto.mappingId }, select: { id: true, customerId: true } });
      // The rule recorded is the one that suggested THIS business.
      if (!m || m.customerId !== business.id) throw new BadRequestException({ code: 'MAPPING_MISMATCH', message: 'That rule does not suggest this business.' });
      mappingId = m.id;
    }

    assertFresh(freshMethod, {
      action: 'devices.adopt',
      message: `Confirm it is you to assign ${dto.endpointIds.length === 1 ? 'this computer' : `${dto.endpointIds.length} computers`} to ${business.name}: everyone in that business with access will be able to see and act on ${dto.endpointIds.length === 1 ? 'it' : 'them'}.`,
    });

    const results: AdoptResult[] = [];
    const now = new Date();
    for (const endpointId of dto.endpointIds) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const before = await tx.endpoint.findFirst({
          where: { AND: [{ id: endpointId }, UNASSIGNED_WHERE, { status: { not: 'ARCHIVED' } }] },
          select: { tenantId: true, customerId: true, siteId: true, status: true, deploymentKeyId: true, arrivedVia: true, name: true, hostname: true },
        });
        if (!before) return 'not_unassigned' as const;
        // Conditional: only from the unassigned state, whatever the read said.
        const moved = await tx.endpoint.updateMany({
          where: { AND: [{ id: endpointId }, UNASSIGNED_WHERE, { status: { not: 'ARCHIVED' } }] },
          data: { tenantId: business.tenantId, customerId: business.id, siteId, status: 'ACTIVE', adoptedAt: now, adoptedById: actor.userId },
        });
        if (moved.count !== 1) return 'not_unassigned' as const;
        await tx.rustdeskNode.updateMany({ where: { endpointId }, data: { tenantId: business.tenantId } });
        if (groupIds.length) {
          await tx.endpointGroupMember.createMany({ data: groupIds.map((g) => ({ endpointGroupId: g, endpointId })), skipDuplicates: true });
        }
        await tx.activityLog.create({
          data: this.audit.entry({
            tenantId: business.tenantId, customerId: business.id, actorId: actor.userId, actorIp: actor.ip,
            action: 'ENDPOINT_ADOPTED', resource: 'endpoint', resourceId: endpointId,
            meta: {
              approvedBy: actor.userId, via, stepUpMethod: freshMethod,
              before: { tenantId: before.tenantId, customerId: before.customerId, siteId: before.siteId, status: before.status },
              after: { tenantId: business.tenantId, customerId: business.id, siteId, status: 'ACTIVE' },
              businessName: business.name, hostname: before.hostname ?? before.name,
              arrivedVia: before.arrivedVia, deploymentKeyId: before.deploymentKeyId, mappingId, groupIds,
            },
          }),
        });
        return 'adopted' as const;
      });
      results.push({ endpointId, result: outcome });
    }
    return { results };
  }

  async forget(actor: ActorContext, raw: unknown, freshMethod: string | null): Promise<{ results: AdoptResult[] }> {
    this.acl.assertPlatformAdmin(actor);
    const parsed = Forget.safeParse(raw);
    if (!parsed.success) throw bad('INVALID_FORGET', parsed.error);
    const ids = [...new Set(parsed.data.endpointIds)];
    assertFresh(freshMethod, {
      action: 'devices.adopt',
      message: 'Confirm it is you to forget these unassigned computers. A computer whose agent keeps running checks in again as a new unassigned entry.',
    });
    const results: AdoptResult[] = [];
    for (const endpointId of ids) {
      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          const before = await tx.endpoint.findFirst({
            where: { AND: [{ id: endpointId }, UNASSIGNED_WHERE] },
            select: { name: true, hostname: true, deploymentKeyId: true, arrivedVia: true, sourceIp: true, rustdeskNode: { select: { rustdeskId: true } } },
          });
          if (!before) return 'not_unassigned' as const;
          const gone = await tx.endpoint.deleteMany({ where: { AND: [{ id: endpointId }, UNASSIGNED_WHERE] } });
          if (gone.count !== 1) return 'not_unassigned' as const;
          await tx.activityLog.create({
            data: this.audit.entry({
              actorId: actor.userId, actorIp: actor.ip, action: 'ENDPOINT_FORGOTTEN', resource: 'endpoint', resourceId: endpointId,
              meta: {
                hostname: before.hostname ?? before.name, rustdeskId: before.rustdeskNode?.rustdeskId ?? null,
                arrivedVia: before.arrivedVia, deploymentKeyId: before.deploymentKeyId, sourceIp: before.sourceIp, stepUpMethod: freshMethod,
              },
            }),
          });
          return 'forgotten' as const;
        });
        results.push({ endpointId, result: outcome });
      } catch (e) {
        // Something still refers to it (a session record): keep it.
        if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2003' || e.code === 'P2014')) { results.push({ endpointId, result: 'in_use' }); continue; }
        throw e;
      }
    }
    return { results };
  }

  // ── Assignment rules ──────────────────────────────────────────────────────

  async listMappings(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    const rows = await this.prisma.adoptionMapping.findMany({ orderBy: [{ kind: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }], take: 2000 });
    const [bs, ss, ks] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.customerId))] } }, select: { id: true, name: true } }),
      this.prisma.site.findMany({ where: { id: { in: rows.map((r) => r.siteId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.deploymentKey.findMany({ where: { id: { in: rows.map((r) => r.deploymentKeyId).filter((x): x is string => !!x) } }, select: { id: true, name: true, revokedAt: true, expiresAt: true, useCount: true, maxUses: true } }),
    ]);
    const b = new Map(bs.map((x) => [x.id, x.name])), s = new Map(ss.map((x) => [x.id, x.name])), k = new Map(ks.map((x) => [x.id, x]));
    return rows.map((r) => {
      const key = r.deploymentKeyId ? k.get(r.deploymentKeyId) : undefined;
      return { ...r, businessName: b.get(r.customerId) ?? null, siteName: r.siteId ? s.get(r.siteId) ?? null : null, keyName: key?.name ?? null, keyState: key ? keyState(key) : null };
    });
  }

  async createMapping(actor: ActorContext, raw: unknown, freshMethod: string | null) {
    this.acl.assertPlatformAdmin(actor);
    const parsed = MappingCreate.safeParse(raw);
    if (!parsed.success) throw bad('INVALID_MAPPING', parsed.error);
    const dto = parsed.data;
    const norm = normaliseValue(dto.kind, dto.value);
    if (!norm.ok) throw new BadRequestException({ code: 'INVALID_MAPPING', message: norm.message });
    const business = await this.prisma.customer.findFirst({ where: { id: dto.businessId, isArchived: false }, select: { id: true, tenantId: true, name: true } });
    if (!business) throw new NotFoundException('Business not found');
    if (dto.siteId) {
      const site = await this.prisma.site.findFirst({ where: { id: dto.siteId, customerId: business.id, isActive: true }, select: { id: true } });
      if (!site) throw new BadRequestException({ code: 'UNKNOWN_SITE', message: 'Unknown site for this business' });
    }
    let deploymentKeyId: string | null = null;
    if (dto.kind === 'deployment_key') {
      const key = await this.prisma.deploymentKey.findUnique({ where: { id: norm.value }, select: { id: true, customerId: true } });
      // A key is bound to one business; a rule cannot point its computers anywhere else.
      if (!key || key.customerId !== business.id) throw new BadRequestException({ code: 'KEY_OTHER_BUSINESS', message: 'A deployment-key rule names a key of the same business.' });
      deploymentKeyId = key.id;
    }

    assertFresh(freshMethod, {
      action: 'adoption.mappings',
      message: 'Confirm it is you to add an assignment rule: it suggests a business for every unassigned computer that matches.',
    });

    let row;
    try {
      row = await this.prisma.adoptionMapping.create({
        data: {
          tenantId: business.tenantId, customerId: business.id, siteId: dto.siteId ?? null, kind: dto.kind, value: norm.value,
          deploymentKeyId, priority: dto.priority, note: dto.note ?? null, createdById: actor.userId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'MAPPING_EXISTS', message: 'A rule for that value already exists. Remove it first to point it elsewhere.' });
      throw e;
    }
    await this.audit.log({
      tenantId: business.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'ADOPTION_MAPPING_CREATED', resource: 'adoption_mapping', resourceId: row.id,
      meta: { kind: row.kind, value: row.value, businessId: business.id, siteId: row.siteId, priority: row.priority, stepUpMethod: freshMethod },
    });
    return row;
  }

  async deleteMapping(actor: ActorContext, mappingId: string) {
    this.acl.assertPlatformAdmin(actor);
    const row = await this.prisma.adoptionMapping.findUnique({ where: { id: mappingId } });
    if (!row) throw new NotFoundException('Rule not found');
    const n = await this.prisma.adoptionMapping.deleteMany({ where: { id: mappingId } });
    if (n.count !== 1) throw new NotFoundException('Rule not found');
    await this.audit.log({
      tenantId: row.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'ADOPTION_MAPPING_DELETED', resource: 'adoption_mapping', resourceId: mappingId,
      meta: { kind: row.kind, value: row.value, businessId: row.customerId, siteId: row.siteId },
    });
    return { id: mappingId, deleted: true };
  }
}
