import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { assertFresh } from '../security-controls/review';
import { KeyCreate, MAX_KEY_DAYS, keyState, newDeploymentKey } from './deployment-key';

const DAY = 24 * 3600_000;

/** Everything about a key a list may show: never the hash. */
const KEY_VIEW = {
  id: true, customerId: true, siteId: true, endpointGroupId: true, name: true, keyHint: true, mode: true, accessMode: true,
  maxUses: true, useCount: true, expiresAt: true, revokedAt: true, revokedById: true, lastUsedAt: true, createdById: true, createdAt: true,
} as const;

/**
 * Deployment keys (0.57, check-security-invariants §70): multi-use enrolment
 * keys for fleet rollout. Platform Admin only — a key in review mode feeds the
 * unassigned pool, which only a Platform Admin can see.
 *
 * Creating one needs a fresh sign-in (`deployment.keys`) after every input
 * check, and is audited. The key is returned once, from create; only its
 * SHA-256 and last four characters are kept. Revoking never asks (it only
 * narrows) and is a conditional write, audited. Nothing here enrols anything:
 * EnrollmentService.claimEndpoint redeems a key.
 */
@Injectable()
export class DeploymentKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  async list(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    const keys = await this.prisma.deploymentKey.findMany({ select: KEY_VIEW, orderBy: { createdAt: 'desc' }, take: 500 });
    const names = await this.names(keys);
    const now = new Date();
    return keys.map((k) => ({
      ...k,
      state: keyState(k, now),
      businessName: names.business.get(k.customerId) ?? null,
      siteName: k.siteId ? names.site.get(k.siteId) ?? null : null,
      groupName: k.endpointGroupId ? names.group.get(k.endpointGroupId) ?? null : null,
    }));
  }

  async create(actor: ActorContext, raw: unknown, freshMethod: string | null) {
    this.acl.assertPlatformAdmin(actor);
    const parsed = KeyCreate.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVALID_KEY', message: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const dto = parsed.data;
    const business = await this.prisma.customer.findFirst({ where: { id: dto.businessId, isArchived: false }, select: { id: true, tenantId: true, name: true } });
    if (!business) throw new NotFoundException('Business not found');
    if (dto.siteId) {
      const site = await this.prisma.site.findFirst({ where: { id: dto.siteId, customerId: business.id, isActive: true }, select: { id: true } });
      if (!site) throw new BadRequestException({ code: 'UNKNOWN_SITE', message: 'Unknown site for this business' });
    }
    if (dto.endpointGroupId) {
      const g = await this.prisma.endpointGroup.findFirst({
        where: { id: dto.endpointGroupId, OR: [{ customerId: business.id }, { customerId: null, tenantId: business.tenantId }] },
        select: { kind: true },
      });
      if (!g) throw new BadRequestException({ code: 'UNKNOWN_GROUP', message: 'Unknown computer group for this business' });
      if (g.kind === 'RULE') throw new BadRequestException({ code: 'RULE_GROUP', message: 'That is a rule group: a computer is in it when it matches the rule. Pick a static group, or none.' });
    }
    if (dto.expiresInDays > MAX_KEY_DAYS) throw new BadRequestException({ code: 'KEY_TOO_LONG', message: `A deployment key lives at most ${MAX_KEY_DAYS} days.` });

    assertFresh(freshMethod, {
      action: 'deployment.keys',
      message: 'Confirm it is you to create a deployment key: it can enrol many computers for this business until it expires, is used up, or is revoked.',
    });

    const { key, hash, hint } = newDeploymentKey();
    const now = new Date();
    const row = await this.prisma.deploymentKey.create({
      data: {
        tenantId: business.tenantId, customerId: business.id, siteId: dto.siteId ?? null, endpointGroupId: dto.endpointGroupId ?? null,
        name: dto.name, keyHash: hash, keyHint: hint, mode: dto.mode, accessMode: dto.accessMode,
        maxUses: dto.maxUses, expiresAt: new Date(now.getTime() + dto.expiresInDays * DAY), createdById: actor.userId, createdAt: now,
      },
      select: KEY_VIEW,
    });
    await this.audit.log({
      tenantId: business.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'DEPLOYMENT_KEY_CREATED', resource: 'deployment_key', resourceId: row.id,
      meta: {
        businessId: business.id, siteId: row.siteId, endpointGroupId: row.endpointGroupId, name: row.name, mode: row.mode,
        accessMode: row.accessMode, maxUses: row.maxUses, expiresAt: row.expiresAt.toISOString(), keyHint: hint, stepUpMethod: freshMethod,
      },
    });
    // The key itself, once. Only its hash is stored.
    return { ...row, state: keyState(row, now), businessName: business.name, key };
  }

  async revoke(actor: ActorContext, id: string) {
    this.acl.assertPlatformAdmin(actor);
    const k = await this.prisma.deploymentKey.findUnique({ where: { id }, select: { id: true, tenantId: true, name: true, revokedAt: true, useCount: true } });
    if (!k) throw new NotFoundException('Deployment key not found');
    const n = await this.prisma.deploymentKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedById: actor.userId } });
    if (n.count !== 1) throw new ConflictException({ code: 'ALREADY_REVOKED', message: 'That key is already revoked.' });
    await this.audit.log({
      tenantId: k.tenantId, actorId: actor.userId, actorIp: actor.ip,
      action: 'DEPLOYMENT_KEY_REVOKED', resource: 'deployment_key', resourceId: id,
      meta: { name: k.name, useCount: k.useCount },
    });
    return { id, revoked: true };
  }

  private async names(keys: { customerId: string; siteId: string | null; endpointGroupId: string | null }[]) {
    const ids = <T>(xs: (T | null)[]) => [...new Set(xs.filter((x): x is T => !!x))];
    const [b, s, g] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: ids(keys.map((k) => k.customerId)) } }, select: { id: true, name: true } }),
      this.prisma.site.findMany({ where: { id: { in: ids(keys.map((k) => k.siteId)) } }, select: { id: true, name: true } }),
      this.prisma.endpointGroup.findMany({ where: { id: { in: ids(keys.map((k) => k.endpointGroupId)) } }, select: { id: true, name: true } }),
    ]);
    return { business: new Map(b.map((x) => [x.id, x.name])), site: new Map(s.map((x) => [x.id, x.name])), group: new Map(g.map((x) => [x.id, x.name])) };
  }
}
