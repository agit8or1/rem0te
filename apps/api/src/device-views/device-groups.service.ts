import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EndpointListService } from '../endpoints/endpoint-list.service';
import { ID, MAX_GROUPS_PER_BUSINESS, manageRefusal } from './rules';
import { MAX_RULE_GROUPS_PER_BUSINESS, parseRule, ruleFilters, type StoredRule } from './group-rule';

const GroupInput = z.object({
  businessId: z.string().regex(ID).optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  /** 0.34: 'static' (hand-kept members) or 'rule' (members computed from `rule`). Fixed at creation. */
  kind: z.enum(['static', 'rule']).default('static'),
  /** Validated by parseRule, not here: z only says it is there. */
  rule: z.unknown().optional(),
}).strict();
const GroupUpdate = z.object({
  name: GroupInput.shape.name,
  description: GroupInput.shape.description,
  rule: z.unknown(),
}).partial().strict();

const parse = <S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> => {
  const p = schema.safeParse(raw ?? {});
  if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  return p.data;
};

export type GroupRow = {
  id: string; tenantId: string; customerId: string | null; name: string; description: string | null;
  kind: 'STATIC' | 'RULE'; rule: Prisma.JsonValue | null;
};
const ROW = { id: true, tenantId: true, customerId: true, name: true, description: true, kind: true, rule: true } as const;

/**
 * Device groups (0.33 static; 0.34 also rule-based).
 *
 * A RULE group (0.34) has no member rows — a trigger refuses them (0053) —
 * and its members are computed on every read by EndpointListService from the
 * rule AND the group's business AND the reader's visibility. Its rule is the
 * device list's own filters (group-rule.ts). Creating, editing and deleting
 * one needs the same manageRefusal() as a static group, and the audit entry
 * carries the rule before and after.
 *
 * Static device groups (0.33). A group belongs to one business and every
 * member is a computer of that business. Since 0.34 membership is
 * EndpointGroupMember, so a computer may be in any number of its business's
 * groups; the same-business rule is also a database trigger (migration
 * 0049). Groups are a device-list filter; they grant nothing.
 *
 * Reading the business's groups needs computers:view; member counts are
 * counted over the computers the reader can see. Creating, renaming and
 * deleting — and adding or removing members, which DeviceBulkService does —
 * need manageRefusal() to pass: the MSP, the Business Owner, or a technician
 * with computers:edit over the whole business. Every change is audited.
 *
 * Another business's group is a 404, the same as one that does not exist.
 */
@Injectable()
export class DeviceGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly deviceList: EndpointListService,
  ) {}

  /** A group this person may address, or 404. Pre-0.33 groups (no business) are reachable by a Platform Admin only. */
  async findVisible(a: ActorContext, id: string): Promise<GroupRow> {
    if (!ID.test(id)) throw new NotFoundException('Group not found');
    const g = await this.prisma.endpointGroup.findUnique({ where: { id }, select: ROW });
    if (!g) throw new NotFoundException('Group not found');
    if (a.isPlatformAdmin) return g;
    if (!g.customerId || g.customerId !== a.businessId) throw new NotFoundException('Group not found');
    return g;
  }

  /** As findVisible, then the manage rule. A pre-0.33 group is never edited here. */
  async findManageable(a: ActorContext, id: string): Promise<GroupRow & { customerId: string }> {
    const g = await this.findVisible(a, id);
    if (!g.customerId) throw new BadRequestException({ code: 'LEGACY_GROUP', message: 'This group predates 0.33 and belongs to no business, so it cannot be edited here.' });
    const why = manageRefusal(a, g.customerId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
    return g as GroupRow & { customerId: string };
  }

  async list(a: ActorContext, requested?: string) {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    if (requested !== undefined && !ID.test(requested)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is not an id' });
    const scope = this.acl.resolveScope(a, requested);
    const where: Prisma.EndpointGroupWhereInput = scope ? { customerId: scope } : {};
    const groups = await this.prisma.endpointGroup.findMany({
      where, orderBy: [{ name: 'asc' }], take: 2000,
      select: { id: true, name: true, description: true, customerId: true, kind: true, rule: true, customer: { select: { name: true } }, createdAt: true, updatedAt: true },
    });
    // A rule group's members, computed as THIS reader sees them (null = its
    // rule reads alerts and the reader may not see alerts).
    const ruled = await this.deviceList.evaluateRuleGroups(a,
      groups.filter((g) => g.kind === 'RULE' && g.customerId).map((g) => ({ id: g.id, name: g.name, customerId: g.customerId!, rule: ruleFilters(g.rule) })),
      { status: 'current' });
    // Members counted over what THIS reader can see, never the raw total.
    const counts = groups.length ? await this.prisma.endpointGroupMember.groupBy({
      by: ['endpointGroupId'],
      where: { endpointGroupId: { in: groups.map((g) => g.id) }, endpoint: { AND: [this.acl.endpointVisibilityWhere(a, scope), { status: { not: 'ARCHIVED' } }] } },
      _count: { _all: true },
    }) : [];
    const n = new Map(counts.map((c) => [c.endpointGroupId, c._count._all]));
    const may = new Map<string, string | null>();
    const refusal = (cid: string) => { if (!may.has(cid)) may.set(cid, manageRefusal(a, cid)); return may.get(cid)!; };
    return {
      groups: groups.map((g) => ({
        id: g.id, name: g.name, description: g.description,
        business: g.customerId ? { id: g.customerId, name: g.customer?.name ?? null } : null,
        legacy: !g.customerId,
        kind: g.kind === 'RULE' ? 'rule' as const : 'static' as const,
        ...(g.kind === 'RULE' ? { rule: g.rule as StoredRule, ruleReadable: ruleFilters(g.rule) !== null } : {}),
        // For a rule group: null when the reader may not evaluate it (its rule reads alerts).
        members: g.kind === 'RULE' ? (ruled.get(g.id) === null ? null : ruled.get(g.id)?.length ?? 0) : (n.get(g.id) ?? 0),
        may: { manage: !!g.customerId && refusal(g.customerId) === null },
        createdAt: g.createdAt, updatedAt: g.updatedAt,
      })),
      may: scope ? { manage: refusal(scope) === null, reason: refusal(scope) } : { manage: a.isPlatformAdmin, reason: a.isPlatformAdmin ? null : 'Pick a business.' },
    };
  }

  /** A rule, validated, whose site (if any) is this business's own — another business's site is "unknown", like a missing one. */
  private async validRule(raw: unknown, customerId: string): Promise<StoredRule> {
    const rule = parseRule(raw);
    if (typeof rule.siteId === 'string') {
      const site = await this.prisma.site.findFirst({ where: { id: rule.siteId, customerId }, select: { id: true } });
      if (!site) throw new BadRequestException({ code: 'INVALID_RULE', message: 'Unknown site for this business' });
    }
    return rule;
  }

  async create(a: ActorContext, raw: unknown) {
    const d = parse(GroupInput, raw);
    if (d.kind === 'static' && d.rule !== undefined) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A static group has no rule; create it with kind "rule".' });
    if (d.kind === 'rule' && d.rule === undefined) throw new BadRequestException({ code: 'INVALID_RULE', message: 'A rule group needs a rule.' });
    const customerId = this.acl.requireScope(a, d.businessId);
    const biz = await this.acl.assertBusinessInScope(a, customerId);
    const why = manageRefusal(a, customerId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
    const rule = d.kind === 'rule' ? await this.validRule(d.rule, customerId) : null;
    if (await this.prisma.endpointGroup.count({ where: { customerId } }) >= MAX_GROUPS_PER_BUSINESS) {
      throw new BadRequestException({ code: 'TOO_MANY_GROUPS', message: `A business can have at most ${MAX_GROUPS_PER_BUSINESS} device groups.` });
    }
    // Every rule group is evaluated on each device-list read that shows groups.
    if (rule && await this.prisma.endpointGroup.count({ where: { customerId, kind: 'RULE' } }) >= MAX_RULE_GROUPS_PER_BUSINESS) {
      throw new BadRequestException({ code: 'TOO_MANY_GROUPS', message: `A business can have at most ${MAX_RULE_GROUPS_PER_BUSINESS} rule groups.` });
    }
    let g;
    try {
      g = await this.prisma.endpointGroup.create({
        data: {
          tenantId: biz.tenantId, customerId, name: d.name, description: d.description || null, createdById: a.userId,
          ...(rule ? { kind: 'RULE' as const, rule } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'NAME_TAKEN', message: 'This business already has a group with that name.' });
      throw e;
    }
    await this.audit.log({
      action: 'DEVICE_GROUP_CREATED', actorId: a.userId, actorIp: a.ip, tenantId: biz.tenantId, customerId,
      resource: 'endpoint_group', resourceId: g.id,
      meta: { name: g.name, description: g.description, kind: rule ? 'rule' : 'static', ...(rule ? { rule } : {}), ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { id: g.id, name: g.name, description: g.description, kind: rule ? 'rule' : 'static', ...(rule ? { rule } : {}), business: { id: customerId, name: biz.name } };
  }

  async update(a: ActorContext, id: string, raw: unknown) {
    const d = parse(GroupUpdate, raw);
    const g = await this.findManageable(a, id);
    if (d.rule !== undefined && g.kind !== 'RULE') {
      throw new BadRequestException({ code: 'NOT_A_RULE_GROUP', message: 'This is a static group: its members are kept by hand, and its kind cannot change.' });
    }
    const rule = d.rule !== undefined ? await this.validRule(d.rule, g.customerId) : undefined;
    let after;
    try {
      after = await this.prisma.endpointGroup.update({
        where: { id: g.id },
        data: {
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.description !== undefined ? { description: d.description || null } : {}),
          ...(rule !== undefined ? { rule } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'NAME_TAKEN', message: 'This business already has a group with that name.' });
      throw e;
    }
    await this.audit.log({
      action: 'DEVICE_GROUP_UPDATED', actorId: a.userId, actorIp: a.ip, tenantId: g.tenantId, customerId: g.customerId,
      resource: 'endpoint_group', resourceId: g.id,
      meta: {
        kind: g.kind === 'RULE' ? 'rule' : 'static',
        before: { name: g.name, description: g.description, ...(g.kind === 'RULE' ? { rule: g.rule } : {}) },
        after: { name: after.name, description: after.description, ...(g.kind === 'RULE' ? { rule: after.rule } : {}) },
        ...(a.technician ? { viaTechnicianAssignment: true } : {}),
      },
    });
    return { id: after.id, name: after.name, description: after.description, kind: g.kind === 'RULE' ? 'rule' : 'static', ...(g.kind === 'RULE' ? { rule: after.rule } : {}) };
  }

  /** Deleting a group removes its members from it (they keep their other groups) and is audited with how many. */
  async remove(a: ActorContext, id: string) {
    const g = await this.findManageable(a, id);
    const released = await this.prisma.$transaction(async (tx) => {
      const r = await tx.endpointGroupMember.deleteMany({ where: { endpointGroupId: g.id } });
      await tx.endpointGroup.delete({ where: { id: g.id } });
      return r.count;
    });
    await this.audit.log({
      action: 'DEVICE_GROUP_DELETED', actorId: a.userId, actorIp: a.ip, tenantId: g.tenantId, customerId: g.customerId,
      resource: 'endpoint_group', resourceId: g.id,
      meta: { name: g.name, kind: g.kind === 'RULE' ? 'rule' : 'static', ...(g.kind === 'RULE' ? { rule: g.rule } : {}), membersReleased: released, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { deleted: true, membersReleased: released };
  }
}
