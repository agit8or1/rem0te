import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SavedView } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import {
  ID, MAX_PERSONAL_VIEWS, MAX_SHARED_VIEWS, VIEW_RESOURCE, ViewInput, ViewUpdate, manageRefusal, normalizeViewFilters,
  type StoredFilters,
} from './rules';

const parse = <S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> => {
  const p = schema.safeParse(raw ?? {});
  if (!p.success) throw new BadRequestException({ code: 'INVALID_VIEW', message: p.error.issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`).join('; ') });
  return p.data;
};

/**
 * Saved device-list views (0.33).
 *
 * A view is a name and the device list's own query parameters — filters
 * (validated by parseListQuery, unknown keys refused), sort, columns and
 * density. It never stores results, and there is no route that runs one:
 * the browser opens a view by calling GET /endpoints/list with its
 * parameters, as the viewer, so the viewer's own visibility always applies.
 * A shared view cannot show anyone a computer they could not already find
 * by typing the same filters.
 *
 *   personal  only its author lists, opens, changes or deletes it;
 *   shared    belongs to ONE business. Everyone who can see that business's
 *             computers (computers:view, in that business) lists it; only
 *             someone who may manage the business (manageRefusal) creates,
 *             changes or deletes it, and those changes are audited. Its
 *             filters may not name another business, or a site or group of
 *             another business.
 *
 * Another business's view, or someone else's personal view, is a 404.
 */
@Injectable()
export class SavedViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  private view(v: SavedView & { customer?: { name: string } | null }, a: ActorContext) {
    return {
      id: v.id, name: v.name, shared: v.shared,
      business: v.customerId ? { id: v.customerId, name: v.customer?.name ?? null } : null,
      filters: v.filters as StoredFilters, columns: v.columns,
      sort: v.sortField ?? 'online', dir: v.sortDir ?? 'asc', density: v.density ?? 'comfortable',
      mine: v.userId === a.userId,
      may: { edit: v.shared ? !!v.customerId && manageRefusal(a, v.customerId) === null : v.userId === a.userId },
      updatedAt: v.updatedAt,
    };
  }

  /** Which businesses' shared views this person lists: their own (or, for a Platform Admin, every one). */
  private sharedWhere(a: ActorContext): Prisma.SavedViewWhereInput | null {
    if (a.isPlatformAdmin) return { shared: true, customerId: { not: null } };
    if (!a.businessId) return null;
    return { shared: true, customerId: a.businessId };
  }

  /** A view this person may open, or 404. */
  private async findVisible(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException('View not found');
    const v = await this.prisma.savedView.findUnique({ where: { id }, include: { customer: { select: { name: true } } } });
    if (!v || v.resource !== VIEW_RESOURCE) throw new NotFoundException('View not found');
    if (!v.shared) {
      if (v.userId !== a.userId) throw new NotFoundException('View not found');
      return v;
    }
    if (!v.customerId || !(a.isPlatformAdmin || v.customerId === a.businessId)) throw new NotFoundException('View not found');
    return v;
  }

  private async findEditable(a: ActorContext, id: string) {
    const v = await this.findVisible(a, id);
    if (v.shared) {
      const why = manageRefusal(a, v.customerId!);
      if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
    }
    return v;
  }

  /** A shared view's filters stay inside its business. */
  private async assertFiltersInBusiness(f: StoredFilters, customerId: string) {
    if (f.businessId && f.businessId !== customerId) {
      throw new BadRequestException({ code: 'VIEW_SCOPE', message: 'A shared view belongs to one business, so its filters cannot name another business.' });
    }
    if (f.siteId && !(await this.prisma.site.findFirst({ where: { id: String(f.siteId), customerId }, select: { id: true } }))) {
      throw new BadRequestException({ code: 'VIEW_SCOPE', message: 'Unknown site for this business.' });
    }
    if (f.groupId && !(await this.prisma.endpointGroup.findFirst({ where: { id: String(f.groupId), customerId }, select: { id: true } }))) {
      throw new BadRequestException({ code: 'VIEW_SCOPE', message: 'Unknown device group for this business.' });
    }
  }

  async list(a: ActorContext) {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    const shared = this.sharedWhere(a);
    const rows = await this.prisma.savedView.findMany({
      where: { resource: VIEW_RESOURCE, OR: [{ shared: false, userId: a.userId }, ...(shared ? [shared] : [])] },
      include: { customer: { select: { name: true } } },
      orderBy: [{ shared: 'asc' }, { name: 'asc' }],
      take: MAX_PERSONAL_VIEWS + MAX_SHARED_VIEWS * (a.isPlatformAdmin ? 20 : 1),
    });
    const canShare = a.businessId ? manageRefusal(a, a.businessId) === null : a.isPlatformAdmin;
    return { views: rows.map((v) => this.view(v, a)), may: { share: canShare } };
  }

  async get(a: ActorContext, id: string) {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    return this.view(await this.findVisible(a, id), a);
  }

  async create(a: ActorContext, raw: unknown) {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    const d = parse(ViewInput, raw);
    const filters = normalizeViewFilters(d.filters);
    let customerId: string | null = null;
    let tenantId = a.tenantId;
    if (d.shared) {
      customerId = this.acl.requireScope(a, d.businessId);
      const biz = await this.acl.assertBusinessInScope(a, customerId);
      tenantId = biz.tenantId;
      const why = manageRefusal(a, customerId);
      if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
      await this.assertFiltersInBusiness(filters, customerId);
      if (await this.prisma.savedView.count({ where: { resource: VIEW_RESOURCE, shared: true, customerId } }) >= MAX_SHARED_VIEWS) {
        throw new BadRequestException({ code: 'TOO_MANY_VIEWS', message: `A business can share at most ${MAX_SHARED_VIEWS} views.` });
      }
    } else {
      if (d.businessId) throw new BadRequestException({ code: 'INVALID_VIEW', message: 'businessId applies only to a shared view; put a business filter in filters instead.' });
      if (await this.prisma.savedView.count({ where: { resource: VIEW_RESOURCE, shared: false, userId: a.userId } }) >= MAX_PERSONAL_VIEWS) {
        throw new BadRequestException({ code: 'TOO_MANY_VIEWS', message: `You can save at most ${MAX_PERSONAL_VIEWS} personal views.` });
      }
    }
    const v = await this.prisma.savedView.create({
      data: {
        tenantId, customerId, userId: a.userId, shared: d.shared, resource: VIEW_RESOURCE, name: d.name,
        filters: filters as Prisma.InputJsonValue, columns: d.columns, sortField: d.sort, sortDir: d.dir, density: d.density,
      },
      include: { customer: { select: { name: true } } },
    });
    if (v.shared) await this.auditShared(a, v, 'created', null);
    return this.view(v, a);
  }

  async update(a: ActorContext, id: string, raw: unknown) {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    const d = parse(ViewUpdate, raw);
    const before = await this.findEditable(a, id);
    const filters = d.filters !== undefined ? normalizeViewFilters(d.filters) : undefined;
    if (filters && before.shared) await this.assertFiltersInBusiness(filters, before.customerId!);
    const v = await this.prisma.savedView.update({
      where: { id: before.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(filters !== undefined ? { filters: filters as Prisma.InputJsonValue } : {}),
        ...(d.columns !== undefined ? { columns: d.columns } : {}),
        ...(d.sort !== undefined ? { sortField: d.sort } : {}),
        ...(d.dir !== undefined ? { sortDir: d.dir } : {}),
        ...(d.density !== undefined ? { density: d.density } : {}),
      },
      include: { customer: { select: { name: true } } },
    });
    if (v.shared) await this.auditShared(a, v, 'updated', before);
    return this.view(v, a);
  }

  async remove(a: ActorContext, id: string) {
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    const v = await this.findEditable(a, id);
    await this.prisma.savedView.delete({ where: { id: v.id } });
    if (v.shared) await this.auditShared(a, v, 'deleted', v);
    return { deleted: true };
  }

  private snapshot(v: SavedView) {
    return { name: v.name, filters: v.filters, columns: v.columns, sort: v.sortField, dir: v.sortDir, density: v.density };
  }

  private auditShared(a: ActorContext, v: SavedView, op: 'created' | 'updated' | 'deleted', before: SavedView | null) {
    return this.audit.log({
      action: 'DEVICE_VIEW_SHARED_CHANGED', actorId: a.userId, actorIp: a.ip,
      tenantId: v.tenantId ?? undefined, customerId: v.customerId ?? undefined,
      resource: 'saved_view', resourceId: v.id,
      meta: {
        op, before: before ? this.snapshot(before) : null, after: op === 'deleted' ? null : this.snapshot(v),
        ...(a.technician ? { viaTechnicianAssignment: true } : {}),
      },
    });
  }
}
