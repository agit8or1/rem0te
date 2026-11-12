import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type MonitorRule } from '@prisma/client';
import { isIP } from 'net';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { validatePeerUrl } from '../integration/peers';
import {
  type Destination, isEmailDestination, LIMITS, NotifyPolicyInput, OPTIONAL, parseParams, RECOMMENDED, RULE_KEY, RuleInput, RulePatch, scopeKeyOf, scopeOfKey, SEVERITIES,
} from './engine';
import { MonitoringService, VIEW_INCLUDE } from './monitoring.service';
import { EmailService } from '../email/email.service';
import { maskAddress } from '../email/mail-content';
import { isMspActor, mayManageNotifications } from './notify-who';
import { AlertEventsService } from './alert-events.service';
import { GroupMembershipService } from '../group-policy/membership.service';

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const SuppressionInput = z.object({
  scope: z.enum(['global', 'business', 'site', 'endpoint']),
  businessId: z.string().regex(ID).optional(),
  siteId: z.string().regex(ID).optional(),
  endpointId: z.string().regex(ID).optional(),
  ruleKeys: z.array(z.string().regex(RULE_KEY)).max(16).default([]),
  reason: z.string().trim().min(3).max(300),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }),
}).strict();
const NoteInput = z.object({ note: z.string().trim().max(300).optional() }).strict();
const ResolveInput = z.object({ note: z.string().trim().min(3).max(300) }).strict();
const AlertQuery = z.object({
  state: z.enum(['open', 'acknowledged', 'resolved', 'active', 'all']).default('active'),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  endpointId: z.string().regex(ID).optional(),
  siteId: z.string().regex(ID).optional(),
  kind: z.string().max(32).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).passthrough();

const MAX_WINDOW_MS = 14 * 24 * 3_600_000;

@Injectable()
export class MonitoringAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly mon: MonitoringService,
    private readonly events: AlertEventsService,
    private readonly email: EmailService,
    private readonly groups: GroupMembershipService,
  ) {}

  // ── Who ───────────────────────────────────────────────────────────────────

  isMsp(a: ActorContext) { return isMspActor(a); }

  /**
   * The business a configuration read is about. An MSP manager who is not a
   * Platform Admin has no business of their own; for monitoring they address
   * any business (or none, meaning the global layer) like a Platform Admin.
   */
  private configScope(a: ActorContext, requested?: string | null): string | null {
    if (this.isMsp(a) && !a.isPlatformAdmin) return requested ?? a.businessId ?? null;
    return this.acl.resolveScope(a, requested);
  }

  private assertConfigure(a: ActorContext, customerId: string) {
    if (this.isMsp(a)) return;
    this.acl.resolveScope(a, customerId); // 403 outside the business
    if (a.technician) {
      if (a.technician.businessId !== customerId || !a.technician.sources.some((s) => (s.capabilities as string[]).includes(CAP.MONITORING_CONFIGURE) && s.endpointIds === null)) {
        throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Configuring monitoring needs monitoring:configure for the whole business.' });
      }
      return;
    }
    if (!this.acl.isBusinessOwner(a) && !a.capabilities.includes(CAP.MONITORING_CONFIGURE)) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Configuring monitoring needs the monitoring:configure permission.' });
    }
  }

  private assertPolicy(a: ActorContext, customerId: string | null) {
    if (!mayManageNotifications(a, customerId, this.acl.isBusinessOwner(a))) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: customerId ? 'Who is notified is set by a Business Owner of this business, or by the MSP.' : 'The global notification policy is set by the MSP.' });
    }
  }

  /** Alerts this person may see. Throws when they may see none. */
  alertWhere(a: ActorContext, businessId?: string | null): Prisma.MonitorAlertWhereInput {
    const scope = this.acl.resolveScope(a, businessId);
    if (this.acl.isBusinessOwner(a)) return scope ? { customerId: scope } : {};
    if (a.technician) {
      const g = a.technician.sources.filter((s) => (s.capabilities as string[]).includes(CAP.ALERTS_VIEW));
      if (!g.length) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Seeing alerts needs the monitoring:alerts permission.' });
      if (g.some((s) => s.endpointIds === null)) return { customerId: a.technician.businessId };
      return { customerId: a.technician.businessId, endpointId: { in: [...new Set(g.flatMap((s) => s.endpointIds ?? []))] } };
    }
    if (!a.capabilities.includes(CAP.ALERTS_VIEW)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Seeing alerts needs the monitoring:alerts permission.' });
    // A Business User sees computer alerts for computers they can see — never a site-wide one.
    return { customerId: scope ?? undefined, endpoint: this.acl.endpointVisibilityWhere(a, scope) };
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  private view(r: Prisma.MonitorAlertGetPayload<{ include: typeof VIEW_INCLUDE }>) {
    return {
      id: r.id, kind: r.kind, monitor: r.ruleKey, severity: r.severity, state: r.state, title: r.title, detail: r.detail,
      business: r.customer ? { id: r.customer.id, name: r.customer.name } : null, site: r.site, computer: r.endpoint,
      firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, occurrences: r.occurrences,
      notifyFrom: r.notifyFrom, escalationLevel: r.escalationLevel, lastNotifiedAt: r.lastNotifiedAt,
      suppressed: r.suppressed, suppressionId: r.suppressionId, parentId: r.parentId,
      acknowledgedAt: r.acknowledgedAt, acknowledgedById: r.acknowledgedById,
      resolvedAt: r.resolvedAt, resolvedById: r.resolvedById, resolvedBy: r.resolvedAt ? (r.resolvedById ? 'person' : 'monitor') : null, resolveNote: r.resolveNote,
      ticket: r.ticketId ? { id: r.ticketId, url: r.ticketUrl, peer: r.ticketPeerId, linkedAt: r.ticketLinkedAt } : null,
    };
  }

  async listAlerts(a: ActorContext, raw: unknown, businessId?: string | null) {
    const q = AlertQuery.safeParse(raw ?? {});
    if (!q.success) throw bad(q.error);
    const st = q.data.state;
    const where: Prisma.MonitorAlertWhereInput = {
      AND: [
        this.alertWhere(a, businessId),
        st === 'all' ? {} : st === 'active' ? { state: { in: ['OPEN', 'ACKNOWLEDGED'] } } : { state: st.toUpperCase() as 'OPEN' },
        q.data.severity ? { severity: q.data.severity.toUpperCase() as 'INFO' } : {},
        q.data.endpointId ? { endpointId: q.data.endpointId } : {},
        q.data.siteId ? { siteId: q.data.siteId } : {},
        q.data.kind ? { kind: q.data.kind } : {},
        q.data.before ? { lastSeenAt: { lt: new Date(q.data.before) } } : {},
      ],
    };
    const rows = await this.prisma.monitorAlert.findMany({ where, include: VIEW_INCLUDE, orderBy: [{ lastSeenAt: 'desc' }], take: q.data.limit });
    return { alerts: rows.map((r) => this.view(r)), next: rows.length === q.data.limit ? rows[rows.length - 1].lastSeenAt.toISOString() : null };
  }

  private async alertFor(a: ActorContext, id: string, businessId?: string | null) {
    if (!ID.test(id)) throw new NotFoundException('Alert not found');
    const r = await this.prisma.monitorAlert.findFirst({ where: { AND: [{ id }, this.alertWhere(a, businessId)] }, include: VIEW_INCLUDE });
    if (!r) throw new NotFoundException('Alert not found');
    return r;
  }

  async getAlert(a: ActorContext, id: string, businessId?: string | null) {
    const r = await this.alertFor(a, id, businessId);
    const [events, children] = await Promise.all([
      this.prisma.monitorAlertEvent.findMany({ where: { alertId: id }, orderBy: { createdAt: 'asc' }, take: 200 }),
      this.prisma.monitorAlert.findMany({ where: { AND: [{ parentId: id }, this.alertWhere(a, businessId)] }, include: VIEW_INCLUDE, take: 200, orderBy: { firstSeenAt: 'asc' } }),
    ]);
    return { ...this.view(r), events: events.map((e) => ({ type: e.type, actorId: e.actorId, detail: e.detail, at: e.createdAt })), children: children.map((c) => this.view(c)) };
  }

  async acknowledge(a: ActorContext, id: string, raw: unknown, businessId?: string | null) {
    const d = NoteInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const r = await this.alertFor(a, id, businessId);
    const u = await this.prisma.monitorAlert.updateMany({ where: { id, state: 'OPEN' }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedById: a.userId } });
    if (!u.count) throw new ConflictException({ code: 'NOT_OPEN', message: `This alert is ${r.state.toLowerCase()}.` });
    await this.prisma.monitorAlertEvent.create({ data: { alertId: id, type: 'acknowledged', actorId: a.userId, detail: d.data.note ? { note: d.data.note } : undefined } });
    await this.audit.log({ action: 'MONITOR_ALERT_ACKNOWLEDGED', tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_alert', resourceId: id, meta: { monitor: r.ruleKey, note: d.data.note ?? null } });
    await this.events.emit(id, 'alert.updated');
    return this.getAlert(a, id, businessId);
  }

  async resolveAlert(a: ActorContext, id: string, raw: unknown, businessId?: string | null) {
    const d = ResolveInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const r = await this.alertFor(a, id, businessId);
    if (r.state === 'RESOLVED') throw new ConflictException({ code: 'NOT_OPEN', message: 'This alert is already resolved.' });
    await this.mon.resolve(r, a.userId, d.data.note);
    await this.audit.log({ action: 'MONITOR_ALERT_RESOLVED', tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_alert', resourceId: id, meta: { monitor: r.ruleKey, note: d.data.note } });
    return this.getAlert(a, id, businessId);
  }

  async summary(a: ActorContext, businessId?: string | null) {
    let where: Prisma.MonitorAlertWhereInput;
    try { where = this.alertWhere(a, businessId); } catch { return { visible: false, open: 0, acknowledged: 0, critical: 0, warning: 0, info: 0, suppressed: 0 }; }
    const rows = await this.prisma.monitorAlert.groupBy({ by: ['state', 'severity', 'suppressed'], where: { AND: [where, { state: { in: ['OPEN', 'ACKNOWLEDGED'] } }] }, _count: true });
    const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r._count, 0);
    return {
      visible: true,
      open: sum((r) => r.state === 'OPEN'), acknowledged: sum((r) => r.state === 'ACKNOWLEDGED'),
      critical: sum((r) => r.severity === 'CRITICAL'), warning: sum((r) => r.severity === 'WARNING'), info: sum((r) => r.severity === 'INFO'),
      suppressed: sum((r) => r.suppressed),
    };
  }

  // ── Monitors ──────────────────────────────────────────────────────────────

  /** Resolve a requested scope into a scope key, checking the person may configure it. */
  private async scopeFor(a: ActorContext, s: { scope: 'global' | 'business' | 'site' | 'group' | 'endpoint'; businessId?: string; siteId?: string; groupId?: string; endpointId?: string }) {
    if (s.scope === 'global') {
      if (s.businessId || s.siteId || s.endpointId || s.groupId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A global monitor names no business, site, group or computer.' });
      if (!this.isMsp(a)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Global monitors are set by the MSP.' });
      return { scopeKey: 'global', customerId: null as string | null, siteId: null as string | null, endpointId: null as string | null, groupId: null as string | null, tenantId: a.tenantId };
    }
    if (s.scope === 'group') {
      // 0.35. The group must be a group of the business the request is about:
      // the caller's own (or, for the MSP, the one named, else the group's).
      // Another business's group is the same 404 as a made-up id.
      if (!s.groupId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'groupId is required.' });
      if (s.siteId || s.endpointId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A group monitor names no site or computer.' });
      let customerId = s.businessId ?? a.businessId ?? null;
      if (!customerId && this.isMsp(a)) customerId = (await this.prisma.endpointGroup.findUnique({ where: { id: s.groupId }, select: { customerId: true } }).catch(() => null))?.customerId ?? null;
      if (!customerId) throw new NotFoundException('Group not found');
      if (!this.isMsp(a) && customerId !== a.businessId) throw new NotFoundException('Group not found');
      const g = await this.groups.groupForPolicy(customerId, s.groupId);
      this.assertConfigure(a, g.customerId);
      const c = await this.prisma.customer.findUnique({ where: { id: g.customerId }, select: { tenantId: true } });
      return { scopeKey: scopeKeyOf({ scope: 'group', id: g.id }), customerId: g.customerId, siteId: null, endpointId: null, groupId: g.id, tenantId: c?.tenantId ?? null };
    }
    if (s.scope === 'business') {
      const id = s.businessId ?? a.businessId;
      if (!id) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is required.' });
      const c = await this.prisma.customer.findUnique({ where: { id }, select: { id: true, tenantId: true } });
      if (!c) throw new NotFoundException('Business not found');
      this.assertConfigure(a, c.id);
      return { scopeKey: scopeKeyOf({ scope: 'business', id: c.id }), customerId: c.id, siteId: null, endpointId: null, groupId: null, tenantId: c.tenantId };
    }
    if (s.scope === 'site') {
      if (!s.siteId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'siteId is required.' });
      const site = await this.prisma.site.findUnique({ where: { id: s.siteId }, select: { id: true, customerId: true, tenantId: true } });
      if (!site) throw new NotFoundException('Site not found');
      try { this.assertConfigure(a, site.customerId); } catch (e) { if (e instanceof ForbiddenException && !this.isMsp(a) && a.businessId !== site.customerId) throw new NotFoundException('Site not found'); throw e; }
      return { scopeKey: scopeKeyOf({ scope: 'site', id: site.id }), customerId: site.customerId, siteId: site.id, endpointId: null, groupId: null, tenantId: site.tenantId };
    }
    if (!s.endpointId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'endpointId is required.' });
    const ep = await this.acl.assertEndpointInScope(a, s.endpointId, CAP.MONITORING_CONFIGURE);
    if (!ep.customerId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'That computer is not in a business yet.' });
    this.assertConfigure(a, ep.customerId);
    return { scopeKey: scopeKeyOf({ scope: 'endpoint', id: ep.id }), customerId: ep.customerId, siteId: null, endpointId: ep.id, groupId: null, tenantId: ep.tenantId };
  }

  private ruleView(r: MonitorRule & { group?: { name: string } | null }) {
    return {
      id: r.id, scopeKey: r.scopeKey, scope: scopeOfKey(r.scopeKey), businessId: r.customerId, siteId: r.siteId, endpointId: r.endpointId,
      groupId: r.groupId, priority: r.priority, group: r.groupId ? { id: r.groupId, name: r.group?.name ?? null } : null,
      key: r.key, kind: r.kind, name: r.name, enabled: r.enabled, severity: r.severity, params: r.params, updatedAt: r.updatedAt,
    };
  }

  /** A group monitor's priority must be free for its key in its business (the partial unique index says the same). */
  private priorityTaken(key: string, priority: number) {
    return new ConflictException({ code: 'PRIORITY_TAKEN', message: `Another device-group monitor called "${key}" in this business already has priority ${priority}. Each group monitor with the same key needs its own priority, so a computer in both groups is decided by it.` });
  }

  /** Rules at every scope this person can see in a business, plus the global ones (read-only below the MSP). */
  async listRules(a: ActorContext, businessId?: string | null) {
    const scope = this.configScope(a, businessId);
    const where: Prisma.MonitorRuleWhereInput = scope ? { OR: [{ scopeKey: 'global' }, { customerId: scope }] } : {};
    if (a.technician) where.AND = [{ OR: [{ endpointId: null }, { endpoint: this.acl.endpointRestrictionWhere(a, CAP.COMPUTERS_VIEW) }] }];
    const rows = await this.prisma.monitorRule.findMany({ where, orderBy: [{ scopeKey: 'asc' }, { key: 'asc' }], take: 1000, include: { group: { select: { name: true } } } });
    let mayConfigure = false;
    if (scope) { try { this.assertConfigure(a, scope); mayConfigure = true; } catch { /* read-only */ } }
    return {
      rules: rows.map((r) => this.ruleView(r)), recommended: RECOMMENDED, optional: OPTIONAL, severities: SEVERITIES,
      may: { global: this.isMsp(a), business: mayConfigure },
    };
  }

  async createRule(a: ActorContext, raw: unknown) {
    const d = RuleInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const p = parseParams(d.data.kind, d.data.params);
    if (!p.ok) throw new BadRequestException({ code: 'INVALID_PARAMS', message: p.error });
    const s = await this.scopeFor(a, d.data);
    if (s.groupId && d.data.priority === undefined) throw new BadRequestException({ code: 'PRIORITY_REQUIRED', message: 'A device-group monitor needs a priority (1 first): it decides between two groups a computer is in that both set this key.' });
    if (!s.groupId && d.data.priority !== undefined) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only a device-group monitor has a priority; the others are decided by how specific their scope is.' });
    const priority = s.groupId ? d.data.priority! : null;
    if (priority !== null && await this.prisma.monitorRule.findFirst({ where: { customerId: s.customerId, key: d.data.key, priority, groupId: { not: null } }, select: { id: true } })) throw this.priorityTaken(d.data.key, priority);
    const n = await this.prisma.monitorRule.count({ where: { scopeKey: s.scopeKey } });
    if (n >= LIMITS.rulesPerScope) throw new BadRequestException({ code: 'TOO_MANY', message: `At most ${LIMITS.rulesPerScope} monitors at one scope.` });
    const dup = () => new ConflictException({ code: 'KEY_EXISTS', message: `A monitor called "${d.data.key}" already exists at this scope. Change that one instead.` });
    if (await this.prisma.monitorRule.findUnique({ where: { scopeKey_key: { scopeKey: s.scopeKey, key: d.data.key } }, select: { id: true } })) throw dup();
    try {
      const r = await this.prisma.monitorRule.create({
        data: { scopeKey: s.scopeKey, customerId: s.customerId, siteId: s.siteId, endpointId: s.endpointId, groupId: s.groupId, priority, key: d.data.key, kind: d.data.kind, name: d.data.name, enabled: d.data.enabled, severity: d.data.severity, params: p.params as Prisma.InputJsonValue, createdById: a.userId },
        include: { group: { select: { name: true } } },
      });
      await this.audit.log({ action: 'MONITOR_RULE_CHANGED', tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_rule', resourceId: r.id, meta: { op: 'create', scope: s.scopeKey, key: r.key, kind: r.kind, enabled: r.enabled, severity: r.severity, params: p.params, ...(s.groupId ? { groupId: s.groupId, priority } : {}) } });
      return this.ruleView(r);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        if (await this.prisma.monitorRule.findUnique({ where: { scopeKey_key: { scopeKey: s.scopeKey, key: d.data.key } }, select: { id: true } })) throw dup();
        if (priority !== null) throw this.priorityTaken(d.data.key, priority);
        throw dup();
      }
      throw e;
    }
  }

  /** Add the recommended monitors that are not already at this scope. Each is a normal, audited rule. */
  async addRecommended(a: ActorContext, raw: unknown) {
    const d = z.object({ scope: z.enum(['global', 'business']), businessId: z.string().regex(ID).optional() }).strict().safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const s = await this.scopeFor(a, d.data);
    const have = new Set((await this.prisma.monitorRule.findMany({ where: { scopeKey: s.scopeKey }, select: { key: true } })).map((r) => r.key));
    const added = [];
    for (const r of RECOMMENDED) {
      if (have.has(r.key)) continue;
      added.push(await this.createRule(a, { scope: d.data.scope, ...(s.customerId ? { businessId: s.customerId } : {}), key: r.key, kind: r.kind, name: r.name, severity: r.severity, params: r.params }));
    }
    return { added };
  }

  private async ruleFor(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException('Monitor not found');
    const r = await this.prisma.monitorRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Monitor not found');
    if (r.scopeKey === 'global') { if (!this.isMsp(a)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Global monitors are changed by the MSP. Override one for your business with the same key.' }); }
    else {
      if (!this.isMsp(a) && a.businessId !== r.customerId) throw new NotFoundException('Monitor not found');
      this.assertConfigure(a, r.customerId!);
      if (r.endpointId) await this.acl.assertEndpointInScope(a, r.endpointId, CAP.MONITORING_CONFIGURE);
    }
    return r;
  }

  async updateRule(a: ActorContext, id: string, raw: unknown) {
    const d = RulePatch.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const r = await this.ruleFor(a, id);
    if (d.data.priority !== undefined && !r.groupId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Only a device-group monitor has a priority.' });
    if (d.data.priority !== undefined && d.data.priority !== r.priority
      && await this.prisma.monitorRule.findFirst({ where: { customerId: r.customerId, key: r.key, priority: d.data.priority, groupId: { not: null }, id: { not: r.id } }, select: { id: true } })) {
      throw this.priorityTaken(r.key, d.data.priority);
    }
    let params: Record<string, unknown> | undefined;
    if (d.data.params) {
      const p = parseParams(r.kind as never, d.data.params);
      if (!p.ok) throw new BadRequestException({ code: 'INVALID_PARAMS', message: p.error });
      params = p.params;
    }
    let u;
    try {
      u = await this.prisma.monitorRule.update({ where: { id }, include: { group: { select: { name: true } } }, data: { ...(d.data.name ? { name: d.data.name } : {}), ...(d.data.enabled !== undefined ? { enabled: d.data.enabled } : {}), ...(d.data.severity ? { severity: d.data.severity } : {}), ...(params ? { params: params as Prisma.InputJsonValue } : {}), ...(d.data.priority !== undefined ? { priority: d.data.priority } : {}), updatedById: a.userId } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002' && d.data.priority !== undefined) throw this.priorityTaken(r.key, d.data.priority);
      throw e;
    }
    await this.audit.log({ action: 'MONITOR_RULE_CHANGED', customerId: r.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_rule', resourceId: id, meta: { op: 'update', scope: r.scopeKey, key: r.key, before: { enabled: r.enabled, severity: r.severity, params: r.params, ...(r.groupId ? { priority: r.priority } : {}) }, after: { enabled: u.enabled, severity: u.severity, params: u.params, ...(r.groupId ? { priority: u.priority } : {}) } } as never });
    return this.ruleView(u);
  }

  async deleteRule(a: ActorContext, id: string) {
    const r = await this.ruleFor(a, id);
    await this.prisma.monitorRule.delete({ where: { id } });
    await this.audit.log({ action: 'MONITOR_RULE_CHANGED', customerId: r.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_rule', resourceId: id, meta: { op: 'delete', scope: r.scopeKey, key: r.key, kind: r.kind } });
    return { deleted: true };
  }

  // ── Maintenance windows ───────────────────────────────────────────────────

  async listSuppressions(a: ActorContext, businessId?: string | null) {
    const scope = this.configScope(a, businessId);
    const rows = await this.prisma.monitorSuppression.findMany({
      where: { ...(scope ? { OR: [{ scopeKey: 'global' }, { customerId: scope }] } : {}), OR: [{ revokedAt: null, endsAt: { gt: new Date() } }, { createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) } }] },
      orderBy: { startsAt: 'desc' }, take: 200,
    });
    const now = new Date();
    return rows.map((s) => ({ ...s, active: !s.revokedAt && s.startsAt <= now && s.endsAt > now }));
  }

  async createSuppression(a: ActorContext, raw: unknown) {
    const d = SuppressionInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const now = Date.now();
    const startsAt = d.data.startsAt ? new Date(d.data.startsAt) : new Date(now);
    const endsAt = new Date(d.data.endsAt);
    if (endsAt <= startsAt || endsAt.getTime() <= now) throw new BadRequestException({ code: 'INVALID_WINDOW', message: 'The window must end after it starts, and in the future.' });
    if (endsAt.getTime() - startsAt.getTime() > MAX_WINDOW_MS) throw new BadRequestException({ code: 'INVALID_WINDOW', message: 'A maintenance window is at most 14 days. Disable the monitor instead if it should stay quiet.' });
    if (startsAt.getTime() > now + 90 * 86_400_000) throw new BadRequestException({ code: 'INVALID_WINDOW', message: 'Schedule windows at most 90 days ahead.' });
    const s = await this.scopeFor(a, d.data);
    const row = await this.prisma.monitorSuppression.create({ data: { scopeKey: s.scopeKey, customerId: s.customerId, siteId: s.siteId, endpointId: s.endpointId, ruleKeys: [...new Set(d.data.ruleKeys)], reason: d.data.reason, startsAt, endsAt, createdById: a.userId } });
    await this.audit.log({ action: 'MONITOR_SUPPRESSION_CHANGED', tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_suppression', resourceId: row.id, meta: { op: 'create', scope: s.scopeKey, ruleKeys: row.ruleKeys, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: row.reason } });
    return row;
  }

  async revokeSuppression(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException('Window not found');
    const s = await this.prisma.monitorSuppression.findUnique({ where: { id } });
    if (!s || s.revokedAt) throw new NotFoundException('Window not found');
    if (s.scopeKey === 'global') { if (!this.isMsp(a)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Global windows are ended by the MSP.' }); }
    else { if (!this.isMsp(a) && a.businessId !== s.customerId) throw new NotFoundException('Window not found'); this.assertConfigure(a, s.customerId!); }
    const now = new Date();
    await this.prisma.monitorSuppression.update({ where: { id }, data: { revokedAt: now, revokedById: a.userId } });
    // Alerts it was holding are looked at again now, not at the original end.
    await this.prisma.monitorAlert.updateMany({ where: { suppressionId: id, state: 'OPEN' }, data: { notifyFrom: now, nextCheckAt: now } });
    await this.audit.log({ action: 'MONITOR_SUPPRESSION_CHANGED', customerId: s.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_suppression', resourceId: id, meta: { op: 'revoke', scope: s.scopeKey } });
    return { revoked: true };
  }

  // ── Notification policy ───────────────────────────────────────────────────

  private maskUrl(u: string) { try { const x = new URL(u); return `${x.protocol}//${x.host}/…`; } catch { return '…'; } }

  async getPolicy(a: ActorContext, businessId?: string | null) {
    const scope = this.configScope(a, businessId);
    const [g, b] = await Promise.all([
      this.prisma.monitorNotifyPolicy.findUnique({ where: { scopeKey: 'global' } }),
      scope ? this.prisma.monitorNotifyPolicy.findUnique({ where: { scopeKey: `b:${scope}` } }) : null,
    ]);
    const mayBusiness = !!scope && (() => { try { this.assertPolicy(a, scope); return true; } catch { return false; } })();
    type Lv = { afterMinutes: number; minSeverity: string; destinations: Destination[] };
    const ids = (p: typeof g) => (p ? (p.levels as Lv[]).flatMap((l) => l.destinations.filter(isEmailDestination).map((d) => d.recipientId)) : []);
    const [ga, ba] = await Promise.all([this.email.addresses(ids(g), 'global'), b ? this.email.addresses(ids(b), b.scopeKey) : new Map()]);
    const show = (p: typeof g, full: boolean, book: typeof ga) => p && {
      scopeKey: p.scopeKey, ticketing: p.ticketing, updatedAt: p.updatedAt, updatedById: p.updatedById,
      levels: (p.levels as Lv[]).map((l) => ({
        ...l,
        destinations: l.destinations.map((d) => {
          if (!isEmailDestination(d)) return { label: d.label, url: full ? d.url : this.maskUrl(d.url) };
          const r = book.get(d.recipientId);
          return { label: d.label, recipientId: d.recipientId, email: r ? (full ? r.address : maskAddress(r.address)) : null, confirmed: !!r?.verifiedAt };
        }),
      })),
    };
    return {
      global: show(g, this.isMsp(a), ga), business: show(b, mayBusiness || this.isMsp(a), ba),
      effective: b ? 'business' : g ? 'global' : 'none',
      may: { global: this.isMsp(a), business: mayBusiness },
    };
  }

  async putPolicy(a: ActorContext, raw: unknown) {
    const d = NotifyPolicyInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const customerId = d.data.scope === 'business' ? (d.data.businessId ?? a.businessId) : null;
    if (d.data.scope === 'business' && !customerId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is required.' });
    if (customerId) {
      const c = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!c) throw new NotFoundException('Business not found');
    }
    this.assertPolicy(a, customerId);
    const scopeKey = customerId ? `b:${customerId}` : 'global';
    for (const l of d.data.levels) for (const dst of l.destinations) if (!isEmailDestination(dst)) this.checkDestination(dst.url, !customerId);
    // An email destination is a confirmed recipient of this policy's own scope — never a typed address.
    const emailIds = d.data.levels.flatMap((l) => l.destinations.filter(isEmailDestination).map((x) => x.recipientId));
    await this.email.assertConfirmed(emailIds, scopeKey);
    const book = await this.email.addresses(emailIds, scopeKey);
    const levels = d.data.levels as unknown as Prisma.InputJsonValue, ticketing = d.data.ticketing as unknown as Prisma.InputJsonValue;
    const row = await this.prisma.monitorNotifyPolicy.upsert({ where: { scopeKey }, create: { scopeKey, customerId, levels, ticketing, updatedById: a.userId }, update: { levels, ticketing, updatedById: a.userId } });
    this.mon.forgetPolicies();
    // Open alerts the sweep already looked at were parked until their next
    // level fell due — an hour out when there was no policy. Without this, an
    // alert raised before the policy existed waits that hour to be announced.
    // The escalation claim in notifyOne keeps a re-check from sending twice.
    await this.prisma.monitorAlert.updateMany({
      where: { state: 'OPEN', suppressed: false, nextCheckAt: { gt: new Date() }, ...(customerId ? { customerId } : {}) },
      data: { nextCheckAt: new Date() },
    });
    await this.audit.log({
      action: 'MONITOR_NOTIFY_POLICY_CHANGED', customerId: customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_notify_policy', resourceId: row.id,
      // Hosts only: a webhook URL's path is often its secret.
      meta: { scope: scopeKey, levels: d.data.levels.map((l) => ({ afterMinutes: l.afterMinutes, minSeverity: l.minSeverity, destinations: l.destinations.map((x) => (isEmailDestination(x) ? `${x.label} → email ${book.get(x.recipientId)?.address ?? x.recipientId}` : `${x.label} → ${this.maskUrl(x.url)}`)) })), ticketing: d.data.ticketing },
    });
    return this.getPolicy(a, customerId);
  }

  /**
   * A business's destinations must be public HTTPS hosts: no IP literals, no
   * localhost, no internal names. The MSP's global policy may also use plain
   * http to loopback (a local relay), like every other peer URL.
   */
  private checkDestination(raw: string, global: boolean) {
    let u: URL;
    try { u = validatePeerUrl(raw, 'destination'); } catch (e) { throw new BadRequestException({ code: 'INVALID_DESTINATION', message: (e as Error).message }); }
    if (global) return;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (u.protocol !== 'https:' || isIP(h) || h === 'localhost' || !h.includes('.') || /\.(local|internal|lan|home|corp|localdomain|localhost)$/.test(h)) {
      throw new BadRequestException({ code: 'INVALID_DESTINATION', message: 'A business notification destination must be an https URL on a public host name.' });
    }
  }

  // ── One computer ──────────────────────────────────────────────────────────

  async endpointView(a: ActorContext, endpointId: string) {
    const ep = await this.acl.assertEndpointInScope(a, endpointId, CAP.COMPUTERS_VIEW);
    const full = await this.prisma.endpoint.findUnique({ where: { id: ep.id }, select: { id: true, customerId: true, siteId: true, accessMode: true, inventory: { select: { monitorReport: true, monitorReportedAt: true, software: true, softwareCount: true, collectedAt: true } } } });
    if (!full || !(await this.acl.canReachEndpoint(a, full, undefined, CAP.COMPUTERS_VIEW))) throw new NotFoundException('Computer not found');
    const { rules, scopes } = await this.mon.resolveFor(full);
    // Names for the scopes a rule came from or beat, so the page can say
    // "set for group Kiosks (priority 2), ahead of group Tills (priority 5)".
    const named = await this.scopeNames(scopes);
    let alerts: ReturnType<MonitoringAdminService['view']>[] | null;
    try {
      const rows = await this.prisma.monitorAlert.findMany({ where: { AND: [this.alertWhere(a, full.customerId), { endpointId: ep.id }] }, include: VIEW_INCLUDE, orderBy: { lastSeenAt: 'desc' }, take: 50 });
      alerts = rows.map((r) => this.view(r));
    } catch { alerts = null; }
    const changes = await this.prisma.endpointChange.findMany({ where: { endpointId: ep.id }, orderBy: { detectedAt: 'desc' }, take: 100 });
    return {
      scopes, scopeNames: named,
      rules: rules.map((r) => ({ key: r.key, kind: r.kind, name: r.name, severity: r.severity, params: r.params, inheritedFrom: r.inheritedFrom, priority: r.priority ?? null, overrides: r.overrides, outranked: r.outranked, id: r.id })),
      report: full.inventory?.monitorReport ?? null, reportedAt: full.inventory?.monitorReportedAt ?? null,
      alerts, changes, software: full.inventory?.software ?? null, softwareCount: full.inventory?.softwareCount ?? null, inventoryAt: full.inventory?.collectedAt ?? null,
    };
  }

  private async scopeNames(scopes: string[]): Promise<Record<string, string>> {
    const ids = (p: string) => scopes.filter((k) => k.startsWith(`${p}:`)).map((k) => k.slice(2));
    const [b, s, g] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: ids('b') } }, select: { id: true, name: true } }),
      this.prisma.site.findMany({ where: { id: { in: ids('s') } }, select: { id: true, name: true } }),
      this.prisma.endpointGroup.findMany({ where: { id: { in: ids('g') } }, select: { id: true, name: true } }),
    ]);
    return {
      global: 'Global', ...Object.fromEntries(b.map((x) => [`b:${x.id}`, `business ${x.name}`])),
      ...Object.fromEntries(s.map((x) => [`s:${x.id}`, `site ${x.name}`])), ...Object.fromEntries(g.map((x) => [`g:${x.id}`, `group ${x.name}`])),
      ...Object.fromEntries(scopes.filter((k) => k.startsWith('e:')).map((k) => [k, 'this computer'])),
    };
  }

  /** For the preview on the rules page: what one computer would actually run. */
  async effectiveFor(a: ActorContext, endpointId: string) {
    const v = await this.endpointView(a, endpointId);
    return { scopes: v.scopes, scopeNames: v.scopeNames, rules: v.rules };
  }
}

