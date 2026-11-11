import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ID, MAX_GROUPS_PER_BUSINESS, manageRefusal } from './rules';

const GroupInput = z.object({
  businessId: z.string().regex(ID).optional(),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
}).strict();
const GroupUpdate = GroupInput.omit({ businessId: true }).partial().strict();

const parse = <S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> => {
  const p = schema.safeParse(raw ?? {});
  if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  return p.data;
};

export type GroupRow = { id: string; tenantId: string; customerId: string | null; name: string; description: string | null };

/**
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
  ) {}

  /** A group this person may address, or 404. Pre-0.33 groups (no business) are reachable by a Platform Admin only. */
  async findVisible(a: ActorContext, id: string): Promise<GroupRow> {
    if (!ID.test(id)) throw new NotFoundException('Group not found');
    const g = await this.prisma.endpointGroup.findUnique({ where: { id }, select: { id: true, tenantId: true, customerId: true, name: true, description: true } });
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
      select: { id: true, name: true, description: true, customerId: true, customer: { select: { name: true } }, createdAt: true, updatedAt: true },
    });
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
        members: n.get(g.id) ?? 0,
        may: { manage: !!g.customerId && refusal(g.customerId) === null },
        createdAt: g.createdAt, updatedAt: g.updatedAt,
      })),
      may: scope ? { manage: refusal(scope) === null, reason: refusal(scope) } : { manage: a.isPlatformAdmin, reason: a.isPlatformAdmin ? null : 'Pick a business.' },
    };
  }

  async create(a: ActorContext, raw: unknown) {
    const d = parse(GroupInput, raw);
    const customerId = this.acl.requireScope(a, d.businessId);
    const biz = await this.acl.assertBusinessInScope(a, customerId);
    const why = manageRefusal(a, customerId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
    if (await this.prisma.endpointGroup.count({ where: { customerId } }) >= MAX_GROUPS_PER_BUSINESS) {
      throw new BadRequestException({ code: 'TOO_MANY_GROUPS', message: `A business can have at most ${MAX_GROUPS_PER_BUSINESS} device groups.` });
    }
    let g;
    try {
      g = await this.prisma.endpointGroup.create({ data: { tenantId: biz.tenantId, customerId, name: d.name, description: d.description || null, createdById: a.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'NAME_TAKEN', message: 'This business already has a group with that name.' });
      throw e;
    }
    await this.audit.log({
      action: 'DEVICE_GROUP_CREATED', actorId: a.userId, actorIp: a.ip, tenantId: biz.tenantId, customerId,
      resource: 'endpoint_group', resourceId: g.id,
      meta: { name: g.name, description: g.description, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { id: g.id, name: g.name, description: g.description, business: { id: customerId, name: biz.name } };
  }

  async update(a: ActorContext, id: string, raw: unknown) {
    const d = parse(GroupUpdate, raw);
    const g = await this.findManageable(a, id);
    let after;
    try {
      after = await this.prisma.endpointGroup.update({
        where: { id: g.id },
        data: { ...(d.name !== undefined ? { name: d.name } : {}), ...(d.description !== undefined ? { description: d.description || null } : {}) },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'NAME_TAKEN', message: 'This business already has a group with that name.' });
      throw e;
    }
    await this.audit.log({
      action: 'DEVICE_GROUP_UPDATED', actorId: a.userId, actorIp: a.ip, tenantId: g.tenantId, customerId: g.customerId,
      resource: 'endpoint_group', resourceId: g.id,
      meta: { before: { name: g.name, description: g.description }, after: { name: after.name, description: after.description }, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { id: after.id, name: after.name, description: after.description };
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
      meta: { name: g.name, membersReleased: released, ...(a.technician ? { viaTechnicianAssignment: true } : {}) },
    });
    return { deleted: true, membersReleased: released };
  }
}
