import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { MonitoringService } from './monitoring.service';
import { MonitoringAdminService } from './monitoring-admin.service';
import { AlertEventsService } from './alert-events.service';
import { QualityRulesService } from './quality-rules.service';
import type { Classification } from './classify';
import {
  FalsePositiveInput, FP_REASON_LABEL, FP_REASONS, priorityOf, qualityChecks, recommendationText, RuleBehaviour, RuleMatch,
  type FpReason, type MonitorStats, type QualityRuleLike, type RecFacts, type ScopeKind,
} from './quality-rules';

type Sev = 'INFO' | 'WARNING' | 'CRITICAL';
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
const DAY = 86_400_000;
/** A recommendation remembers at most this many computers and reporters. */
const REC_LIST_CAP = 200;

const Filters = z.object({
  businessId: z.string().regex(ID).optional(),
  endpointId: z.string().regex(ID).optional(),
  monitor: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  reason: z.enum(FP_REASONS).optional(),
  status: z.enum(['open', 'converted', 'dismissed']).optional(),
  reportedBy: z.string().regex(ID).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strip();
type Filters = z.infer<typeof Filters>;
const DismissInput = z.object({ note: z.string().trim().min(3).max(300) }).strict();

/**
 * False-positive reports (0.67), recommendations, the quality dashboard and
 * the monitoring-quality checks. A report is a person saying "this alert was
 * not a real problem": it is recorded, it may resolve that one alert, and it
 * may count towards a recommendation. It never changes a monitor or a rule,
 * however many people make it — a rule is proposed, tested and approved in
 * QualityRulesService, and a monitor is changed in Monitoring → Monitoring policies.
 */
@Injectable()
export class FalsePositiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly admin: MonitoringAdminService,
    private readonly mon: MonitoringService,
    private readonly events: AlertEventsService,
    private readonly rules: QualityRulesService,
  ) {}

  private async alertFor(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Alert not found' });
    const r = await this.prisma.monitorAlert.findFirst({ where: { AND: [{ id }, this.admin.alertWhere(a)] } });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Alert not found' });
    return r;
  }

  /** What an alert's report is about: the newest event's facts, from the alert itself. */
  private async factsOf(alert: { ruleId: string | null; ruleKey: string; kind: string; severity: string; detail: unknown; classification: unknown; endpointId: string | null; fingerprint: string | null }): Promise<RecFacts> {
    const monitor = alert.ruleId ? await this.prisma.monitorRule.findUnique({ where: { id: alert.ruleId }, select: { name: true, severity: true, params: true } }) : null;
    const d = (alert.detail && typeof alert.detail === 'object' ? alert.detail : {}) as Record<string, unknown>;
    const fp = alert.fingerprint && alert.endpointId
      ? await this.prisma.monitorEventFingerprint.findFirst({ where: { endpointId: alert.endpointId, ruleKey: alert.ruleKey, fingerprint: alert.fingerprint }, select: { provider: true, eventId: true, level: true, statusCode: true, component: true, log: true } })
      : null;
    const cls = alert.classification as Classification | null;
    const s0 = cls?.samples?.[0];
    const params = (monitor?.params ?? {}) as Record<string, unknown>;
    return {
      kind: alert.kind, monitorName: monitor?.name ?? alert.ruleKey, monitorSeverity: (monitor?.severity ?? alert.severity) as Sev,
      log: fp?.log ?? (typeof params.log === 'string' ? params.log : typeof d.log === 'string' ? d.log : null),
      provider: fp?.provider ?? s0?.provider ?? null, eventId: fp?.eventId ?? s0?.eventId ?? null, level: fp?.level ?? s0?.level ?? null,
      statusCode: fp?.statusCode ?? s0?.statusCode ?? null, component: fp?.component ?? s0?.component ?? null, className: cls?.class ?? null,
    };
  }

  /** Everything the Report False Positive dialog shows. Read-only. */
  async context(a: ActorContext, id: string) {
    const r = await this.alertFor(a, id);
    const where = this.admin.alertWhere(a);
    const facts = await this.factsOf(r);
    const similarWhere: Prisma.MonitorAlertWhereInput = r.fingerprint
      ? { AND: [where, { fingerprint: r.fingerprint, ruleKey: r.ruleKey }] }
      : { AND: [where, { ruleKey: r.ruleKey, firstSeenAt: { gte: new Date(Date.now() - 30 * DAY) } }] };
    const [similar, byEndpoint, byBusiness, reports, mine, openRec] = await Promise.all([
      this.prisma.monitorAlert.count({ where: similarWhere }),
      this.prisma.monitorAlert.groupBy({ by: ['endpointId'], where: similarWhere, _count: true, orderBy: { _count: { endpointId: 'desc' } }, take: 10 }),
      this.prisma.monitorAlert.groupBy({ by: ['customerId'], where: similarWhere, _count: true }),
      this.prisma.alertFalsePositiveReport.count({ where: { alertId: r.id } }),
      this.prisma.alertFalsePositiveReport.findFirst({ where: { alertId: r.id, reportedById: a.userId }, select: { reason: true, createdAt: true } }),
      this.prisma.alertRuleRecommendation.findFirst({ where: { status: 'open', customerId: r.customerId, ruleKey: r.ruleKey, fingerprint: r.fingerprint }, select: { id: true, reportCount: true } }),
    ]);
    const eps = await this.prisma.endpoint.findMany({ where: { id: { in: byEndpoint.map((x) => x.endpointId).filter((x): x is string => !!x) } }, select: { id: true, name: true, hostname: true } });
    const em = new Map(eps.map((e) => [e.id, e.name ?? e.hostname ?? e.id]));
    const cls = r.classification as Classification | null;
    const proposed = recommendationText({ ruleKey: r.ruleKey, fingerprint: r.fingerprint, facts, reasons: {}, reportCount: 1, computers: byEndpoint.length || 1, businessId: r.customerId });
    return {
      alert: { id: r.id, title: r.title, severity: r.severity, state: r.state, kind: r.kind, monitor: r.ruleKey, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, occurrences: r.occurrences, detail: r.detail, fingerprint: r.fingerprint },
      rawEvent: cls?.samples?.[0] ?? null,
      monitor: { key: r.ruleKey, name: facts.monitorName, severity: facts.monitorSeverity, log: facts.log },
      classification: cls ? { class: cls.class, basis: cls.basis, matched: cls.matched ?? null } : null,
      similar: { count: similar, businesses: byBusiness.length, computers: byEndpoint.map((x) => ({ id: x.endpointId, name: x.endpointId ? em.get(x.endpointId) ?? null : null, alerts: x._count })) },
      falsePositive: { reports, mine, openRecommendation: openRec },
      reasons: FP_REASONS.map((k) => ({ key: k, label: FP_REASON_LABEL[k] })),
      proposedHandling: { ...proposed, note: 'A suggestion only. Recommending prevention adds your report to a recommendation that someone who configures monitoring reviews, tests against stored history and approves. Nothing changes until then.' },
    };
  }

  /**
   * Record a report. It may resolve this one alert (`resolve`), exactly as
   * Resolve does. It never touches a monitor or a rule.
   */
  async report(a: ActorContext, id: string, raw: unknown, now = new Date()) {
    const p = FalsePositiveInput.safeParse(raw ?? {});
    if (!p.success) throw bad(p.error);
    const d = p.data;
    const r = await this.alertFor(a, id);
    const facts = await this.factsOf(r);
    const cls = r.classification as Classification | null;
    let recommendationId: string | null;
    let reportId: string;
    try {
      ({ reportId, recommendationId } = await this.prisma.$transaction(async (tx) => {
        const rep = await tx.alertFalsePositiveReport.create({
          data: {
            alertId: r.id, tenantId: r.tenantId, customerId: r.customerId, endpointId: r.endpointId, ruleId: r.ruleId, ruleKey: r.ruleKey, kind: r.kind, fingerprint: r.fingerprint,
            alertSeverity: r.severity, alertClass: cls?.class ?? null, alertTitle: r.title.slice(0, 300), reason: d.reason, comment: d.comment || null, recommendPrevent: d.recommendPrevent, reportedById: a.userId,
          },
        });
        let recId: string | null = null;
        if (d.recommendPrevent) {
          recId = await this.recommend(tx, r, facts, a.userId, d.reason, now);
          await tx.alertFalsePositiveReport.update({ where: { id: rep.id }, data: { recommendationId: recId } });
        }
        await tx.monitorAlertEvent.create({ data: { alertId: r.id, type: 'false_positive_reported', actorId: a.userId, detail: { reason: d.reason, recommendPrevent: d.recommendPrevent, ...(d.comment ? { comment: d.comment } : {}), recommendationId: recId } } });
        return { reportId: rep.id, recommendationId: recId };
      }));
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'ALREADY_REPORTED', message: 'You have already reported this alert as a false positive.' });
      throw e;
    }
    await this.audit.log({
      action: 'ALERT_FALSE_POSITIVE_REPORTED', actorId: a.userId, actorIp: a.ip, tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'monitor_alert', resourceId: r.id,
      // Ids and the reason, never the comment.
      meta: { report: reportId, monitor: r.ruleKey, reason: d.reason, recommendPrevent: d.recommendPrevent, recommendation: recommendationId, resolve: d.resolve, severity: r.severity },
    });
    let resolved = false;
    if (d.resolve && r.state !== 'RESOLVED') {
      await this.mon.resolve(r, a.userId, `Reported as a false positive: ${FP_REASON_LABEL[d.reason]}.`, now);
      await this.audit.log({ action: 'MONITOR_ALERT_RESOLVED', tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, actorId: a.userId, actorIp: a.ip, resource: 'monitor_alert', resourceId: r.id, meta: { monitor: r.ruleKey, note: 'false positive', falsePositive: reportId } });
      resolved = true;
    } else {
      await this.events.emit(r.id, 'alert.updated');
    }
    return { id: reportId, recommendationId, resolved, monitorChanged: false, ruleChanged: false };
  }

  /** Add one report to the open recommendation for this monitor and signature in this business, or open one. */
  private async recommend(tx: Prisma.TransactionClient, r: { tenantId: string | null; customerId: string | null; ruleKey: string; ruleId: string | null; fingerprint: string | null; endpointId: string | null }, facts: RecFacts, userId: string, reason: FpReason, now: Date) {
    const where = { status: 'open', customerId: r.customerId, ruleKey: r.ruleKey, fingerprint: r.fingerprint };
    const bump = async (cur: { id: string; reporters: unknown; reasons: unknown; endpointIds: unknown; reportCount: number }) => {
      const reporters = new Set(Array.isArray(cur.reporters) ? (cur.reporters as string[]) : []);
      const eps = new Set(Array.isArray(cur.endpointIds) ? (cur.endpointIds as string[]) : []);
      const reasons = { ...((cur.reasons ?? {}) as Record<string, number>) };
      if (reporters.size < REC_LIST_CAP) reporters.add(userId);
      if (r.endpointId && eps.size < REC_LIST_CAP) eps.add(r.endpointId);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      const u = await tx.alertRuleRecommendation.updateMany({
        where: { id: cur.id, status: 'open', reportCount: cur.reportCount },
        data: { reportCount: { increment: 1 }, reporters: [...reporters], endpointIds: [...eps], reasons, lastReportedAt: now, facts: facts as unknown as Prisma.InputJsonValue },
      });
      if (!u.count) throw new ConflictException({ code: 'RECOMMENDATION_CHANGED', message: 'Someone reported this at the same moment. Try again.' });
      return cur.id;
    };
    const cur = await tx.alertRuleRecommendation.findFirst({ where });
    if (cur) return bump(cur);
    const made = await tx.alertRuleRecommendation.create({
      data: {
        tenantId: r.tenantId, customerId: r.customerId, ruleKey: r.ruleKey, ruleId: r.ruleId, fingerprint: r.fingerprint, facts: facts as unknown as Prisma.InputJsonValue,
        reporters: [userId], reasons: { [reason]: 1 }, endpointIds: r.endpointId ? [r.endpointId] : [], firstReportedAt: now, lastReportedAt: now,
      },
    });
    return made.id;
  }

  // ── The dashboard ─────────────────────────────────────────────────────────

  private filters(raw: unknown) {
    const f = Filters.safeParse(raw ?? {});
    if (!f.success) throw bad(f.error);
    return f.data;
  }

  /** Reports this person may see: the same rule as their alerts. */
  private reportWhere(a: ActorContext, f: Filters): Prisma.AlertFalsePositiveReportWhereInput {
    const base = this.admin.alertWhere(a, f.businessId) as Prisma.AlertFalsePositiveReportWhereInput;
    return {
      AND: [base,
        f.endpointId ? { endpointId: f.endpointId } : {}, f.monitor ? { ruleKey: f.monitor } : {},
        f.severity ? { alertSeverity: f.severity.toUpperCase() as Sev } : {}, f.reason ? { reason: f.reason } : {}, f.reportedBy ? { reportedById: f.reportedBy } : {},
        f.from || f.to ? { createdAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } } : {},
      ],
    };
  }

  /** Recommendations this person may see: their business's (the MSP and Platform Admins: every one). */
  private recWhere(a: ActorContext, f: Pick<Filters, 'businessId' | 'monitor'> & { status?: Filters['status'] | 'any' }): Prisma.AlertRuleRecommendationWhereInput {
    this.admin.alertWhere(a, f.businessId);
    const scope = this.acl.resolveScope(a, f.businessId);
    const wide = a.isPlatformAdmin || this.admin.isMsp(a);
    const biz = wide ? (scope ? { customerId: scope } : {}) : { customerId: a.technician?.businessId ?? scope ?? '-' };
    return { AND: [biz, f.monitor ? { ruleKey: f.monitor } : {}, f.status === 'any' ? {} : { status: f.status ?? 'open' }] };
  }

  private ruleWhere(a: ActorContext, f: Pick<Filters, 'businessId' | 'monitor'>): Prisma.AlertQualityRuleWhereInput {
    const scope = this.acl.resolveScope(a, f.businessId);
    const wide = a.isPlatformAdmin || this.admin.isMsp(a);
    const biz = wide ? (scope ? { OR: [{ customerId: scope }, { customerId: null }] } : {}) : { OR: [{ customerId: a.technician?.businessId ?? scope ?? '-' }, { customerId: null }] };
    return { AND: [biz, f.monitor ? { ruleKey: f.monitor } : {}] };
  }

  async summary(a: ActorContext, raw: unknown, now = new Date()) {
    const f = this.filters(raw);
    const rw = this.reportWhere(a, f);
    const qw = this.ruleWhere(a, f);
    const alertW: Prisma.MonitorAlertWhereInput = { AND: [this.admin.alertWhere(a, f.businessId), f.endpointId ? { endpointId: f.endpointId } : {}, f.monitor ? { ruleKey: f.monitor } : {}, f.severity ? { severity: f.severity.toUpperCase() as Sev } : {}] };
    const soon = new Date(now.getTime() + 7 * DAY);
    const [reports, pending, pendingRules, active, temporary, expiring, reviewDue, byMonitor, byEndpoint, byBusiness, byReason, noise, shadow] = await Promise.all([
      this.prisma.alertFalsePositiveReport.count({ where: rw }),
      this.prisma.alertRuleRecommendation.count({ where: this.recWhere(a, { ...f, status: 'open' }) }),
      this.prisma.alertQualityRule.count({ where: { AND: [qw, { status: 'pending' }] } }),
      this.prisma.alertQualityRule.count({ where: { AND: [qw, { status: 'active' }] } }),
      this.prisma.alertQualityRule.count({ where: { AND: [qw, { status: 'active', temporary: true, expiresAt: { gt: now } }] } }),
      this.prisma.alertQualityRule.count({ where: { AND: [qw, { status: 'active', temporary: true, expiresAt: { gt: now, lte: soon } }] } }),
      this.prisma.alertQualityRule.count({ where: { AND: [qw, { status: 'active', temporary: false, reviewAt: { lte: soon } }] } }),
      this.prisma.alertFalsePositiveReport.groupBy({ by: ['ruleKey'], where: rw, _count: true, orderBy: { _count: { ruleKey: 'desc' } }, take: 10 }),
      this.prisma.alertFalsePositiveReport.groupBy({ by: ['endpointId'], where: rw, _count: true, orderBy: { _count: { endpointId: 'desc' } }, take: 10 }),
      this.prisma.alertFalsePositiveReport.groupBy({ by: ['customerId'], where: rw, _count: true, orderBy: { _count: { customerId: 'desc' } }, take: 10 }),
      this.prisma.alertFalsePositiveReport.groupBy({ by: ['reason'], where: rw, _count: true }),
      this.prisma.alertQualityRule.aggregate({ where: { AND: [qw, { status: { in: ['active', 'expired', 'rolled_back', 'superseded'] } }] }, _sum: { matchCount: true } }),
      this.prisma.alertQualityRule.aggregate({ where: { AND: [qw, { status: 'pending' }] }, _sum: { shadowMatchCount: true } }),
    ]);
    const [eps, bizs] = await Promise.all([
      this.prisma.endpoint.findMany({ where: { id: { in: byEndpoint.map((x) => x.endpointId).filter((x): x is string => !!x) } }, select: { id: true, name: true, hostname: true } }),
      this.prisma.customer.findMany({ where: { id: { in: byBusiness.map((x) => x.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    const em = new Map(eps.map((e) => [e.id, e.name ?? e.hostname ?? e.id])), bm = new Map(bizs.map((b) => [b.id, b.name]));
    // Accuracy, week by week: of the alerts raised, how many nobody reported as false.
    const weeks = 12;
    const since = new Date(now.getTime() - weeks * 7 * DAY);
    const [alertsRaised, fpRows] = await Promise.all([
      this.prisma.monitorAlert.findMany({ where: { AND: [alertW, { firstSeenAt: { gte: since } }] }, select: { firstSeenAt: true }, take: 50_000 }),
      this.prisma.alertFalsePositiveReport.findMany({ where: { AND: [rw, { createdAt: { gte: since } }] }, select: { createdAt: true, alertId: true }, take: 50_000 }),
    ]);
    const bucket = (d: Date) => Math.min(weeks - 1, Math.floor((now.getTime() - d.getTime()) / (7 * DAY)));
    const trend = Array.from({ length: weeks }, (_, i) => ({ weekStart: new Date(now.getTime() - (i + 1) * 7 * DAY).toISOString().slice(0, 10), alerts: 0, falsePositives: 0, accuracy: null as number | null }));
    for (const x of alertsRaised) trend[bucket(x.firstSeenAt)].alerts++;
    const seenAlert = new Set<string>();
    for (const x of fpRows) { const k = x.alertId ?? `r${x.createdAt.getTime()}`; if (seenAlert.has(k)) continue; seenAlert.add(k); trend[bucket(x.createdAt)].falsePositives++; }
    for (const t of trend) t.accuracy = t.alerts ? Math.max(0, Math.round((1000 * (t.alerts - t.falsePositives)) / t.alerts) / 10) : null;
    return {
      totals: { reports, pendingRecommendations: pending, pendingRules, approvedRules: active, temporaryExceptions: temporary, expiringSoon: expiring, reviewDue, noisePrevented: noise._sum.matchCount ?? 0, shadowMatches: shadow._sum.shadowMatchCount ?? 0 },
      top: {
        monitors: byMonitor.map((x) => ({ key: x.ruleKey, reports: x._count })),
        computers: byEndpoint.map((x) => ({ id: x.endpointId, name: x.endpointId ? em.get(x.endpointId) ?? null : null, reports: x._count })),
        businesses: byBusiness.map((x) => ({ id: x.customerId, name: x.customerId ? bm.get(x.customerId) ?? null : null, reports: x._count })),
        reasons: byReason.map((x) => ({ reason: x.reason, label: FP_REASON_LABEL[x.reason as FpReason] ?? x.reason, reports: x._count })),
      },
      trend: trend.reverse(),
    };
  }

  async reports(a: ActorContext, raw: unknown) {
    const f = this.filters(raw);
    const rows = await this.prisma.alertFalsePositiveReport.findMany({
      where: { AND: [this.reportWhere(a, f), f.before ? { createdAt: { lt: new Date(f.before) } } : {}] }, orderBy: { createdAt: 'desc' }, take: f.limit,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.reportedById))] } }, select: { id: true, email: true } });
    const um = new Map(users.map((u) => [u.id, u.email]));
    const eps = await this.prisma.endpoint.findMany({ where: { id: { in: rows.map((r) => r.endpointId).filter((x): x is string => !!x) } }, select: { id: true, name: true, hostname: true } });
    const em = new Map(eps.map((e) => [e.id, e.name ?? e.hostname ?? e.id]));
    return {
      reports: rows.map((r) => ({
        id: r.id, alertId: r.alertId, title: r.alertTitle, monitor: r.ruleKey, severity: r.alertSeverity, class: r.alertClass, reason: r.reason, reasonLabel: FP_REASON_LABEL[r.reason as FpReason] ?? r.reason,
        comment: r.comment, recommendPrevent: r.recommendPrevent, recommendationId: r.recommendationId, computer: r.endpointId ? { id: r.endpointId, name: em.get(r.endpointId) ?? null } : null,
        businessId: r.customerId, reportedBy: um.get(r.reportedById) ?? r.reportedById, reportedById: r.reportedById, at: r.createdAt,
      })),
      next: rows.length === f.limit ? rows[rows.length - 1].createdAt.toISOString() : null,
    };
  }

  // ── Recommendations ───────────────────────────────────────────────────────

  private recView(r: Prisma.AlertRuleRecommendationGetPayload<object>, names: Map<string, string>, now: Date) {
    const reporters = Array.isArray(r.reporters) ? (r.reporters as string[]) : [];
    const eps = Array.isArray(r.endpointIds) ? (r.endpointIds as string[]) : [];
    const reasons = (r.reasons ?? {}) as Record<string, number>;
    const text = recommendationText({ ruleKey: r.ruleKey, fingerprint: r.fingerprint, facts: r.facts as unknown as RecFacts, reasons, reportCount: r.reportCount, computers: eps.length, businessId: r.customerId });
    return {
      id: r.id, status: r.status, monitorKey: r.ruleKey, fingerprint: r.fingerprint, businessId: r.customerId, business: r.customerId ? names.get(r.customerId) ?? null : null,
      reportCount: r.reportCount, reporters: reporters.length, computers: eps.length, reasons, firstReportedAt: r.firstReportedAt, lastReportedAt: r.lastReportedAt,
      priority: priorityOf({ reportCount: r.reportCount, reporters: reporters.length, computers: eps.length, lastReportedAt: r.lastReportedAt }, now),
      qualityRuleId: r.qualityRuleId, dismissedAt: r.dismissedAt, dismissNote: r.dismissNote, ...text,
    };
  }

  async recommendations(a: ActorContext, raw: unknown, now = new Date()) {
    const f = this.filters(raw);
    const rows = await this.prisma.alertRuleRecommendation.findMany({ where: this.recWhere(a, f), orderBy: { lastReportedAt: 'desc' }, take: 200 });
    const names = new Map((await this.prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    return { recommendations: rows.map((r) => this.recView(r, names, now)).sort((x, y) => y.priority - x.priority) };
  }

  private async recFor(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recommendation not found' });
    const r = await this.prisma.alertRuleRecommendation.findFirst({ where: { AND: [{ id }, this.recWhere(a, { status: 'any' })] } });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recommendation not found' });
    return r;
  }

  /** Dismiss: the reports stay; a new report opens a new recommendation. Needs monitoring:configure for that business. */
  async dismiss(a: ActorContext, id: string, raw: unknown, now = new Date()) {
    const p = DismissInput.safeParse(raw ?? {});
    if (!p.success) throw bad(p.error);
    const r = await this.recFor(a, id);
    if (r.customerId) this.admin.assertConfigure(a, r.customerId);
    else if (!a.isPlatformAdmin || a.technician) throw new ForbiddenException({ code: 'PLATFORM_ADMIN_ONLY', message: 'This recommendation is a Platform Admin\'s.' });
    const u = await this.prisma.alertRuleRecommendation.updateMany({ where: { id: r.id, status: 'open' }, data: { status: 'dismissed', dismissedById: a.userId, dismissedAt: now, dismissNote: p.data.note } });
    if (!u.count) throw new ConflictException({ code: 'NOT_OPEN', message: 'This recommendation is no longer open.' });
    await this.audit.log({ action: 'ALERT_RECOMMENDATION_DISMISSED', actorId: a.userId, actorIp: a.ip, tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'alert_rule_recommendation', resourceId: r.id, meta: { monitor: r.ruleKey, reportCount: r.reportCount } });
    return { id: r.id, status: 'dismissed' };
  }

  /** "Preview matching events": a simulation of the recommendation's draft rule, stored nowhere. */
  async preview(a: ActorContext, id: string, now = new Date()) {
    const r = await this.recFor(a, id);
    const v = this.recView(r, new Map(), now);
    if (!v.draft) return { recommendation: v, simulation: null };
    return { recommendation: v, simulation: await this.rules.simulateDraft(a, v.draft, now) };
  }

  // ── Monitoring-quality checks ─────────────────────────────────────────────

  /** Recommendations about the monitors themselves. Read-only: nothing here changes or disables a monitor. */
  async checks(a: ActorContext, raw: unknown, now = new Date()) {
    const f = this.filters(raw);
    const aw = this.admin.alertWhere(a, f.businessId);
    const scope = this.acl.resolveScope(a, f.businessId);
    const wide = a.isPlatformAdmin || this.admin.isMsp(a);
    const biz = wide ? scope : (a.technician?.businessId ?? scope);
    const monitors = await this.prisma.monitorRule.findMany({
      where: { AND: [biz ? { OR: [{ customerId: null }, { customerId: biz }] } : {}, f.monitor ? { key: f.monitor } : {}] },
      select: { id: true, key: true, name: true, kind: true, severity: true, enabled: true, params: true, createdAt: true, customerId: true }, take: 500,
    });
    const ids = monitors.map((m) => m.id);
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    const w = (extra: Prisma.MonitorAlertWhereInput): Prisma.MonitorAlertWhereInput => ({ AND: [aw, { ruleId: { in: ids } }, extra] });
    const count = (rows: { ruleId: string | null; _count: number }[]) => new Map(rows.map((r) => [r.ruleId, r._count]));
    const [a7, aP7, a30, a90, inf30, fp30, eps7, resolved7] = await Promise.all([
      this.prisma.monitorAlert.groupBy({ by: ['ruleId'], where: w({ firstSeenAt: { gte: ago(7) } }), _count: true }),
      this.prisma.monitorAlert.groupBy({ by: ['ruleId'], where: w({ firstSeenAt: { gte: ago(14), lt: ago(7) } }), _count: true }),
      this.prisma.monitorAlert.groupBy({ by: ['ruleId'], where: w({ firstSeenAt: { gte: ago(30) } }), _count: true }),
      this.prisma.monitorAlert.groupBy({ by: ['ruleId'], where: w({ firstSeenAt: { gte: ago(90) } }), _count: true }),
      this.prisma.monitorAlert.groupBy({ by: ['ruleId'], where: w({ firstSeenAt: { gte: ago(30) }, classification: { path: ['class'], equals: 'INFORMATIONAL' } }), _count: true }),
      this.prisma.alertFalsePositiveReport.groupBy({ by: ['ruleId'], where: { AND: [this.reportWhere(a, { ...f, from: undefined, to: undefined }), { ruleId: { in: ids }, createdAt: { gte: ago(30) } }] }, _count: true }),
      this.prisma.monitorAlert.groupBy({ by: ['ruleId', 'endpointId'], where: w({ firstSeenAt: { gte: ago(7) }, endpointId: { not: null } }), _count: true, orderBy: [{ ruleId: 'asc' }, { endpointId: 'asc' }], take: 20_000 }),
      this.prisma.monitorAlert.findMany({ where: w({ resolvedAt: { gte: ago(7) } }), select: { ruleId: true, firstSeenAt: true, resolvedAt: true, resolvedById: true }, take: 20_000 }),
    ]);
    const m7 = count(a7), mP7 = count(aP7), m30 = count(a30), m90 = count(a90), mInf = count(inf30), mFp = count(fp30);
    const epIds = [...new Set(eps7.map((x) => x.endpointId).filter((x): x is string => !!x))];
    const versions = new Map((await this.prisma.endpoint.findMany({ where: { id: { in: epIds } }, select: { id: true, agentVersion: true } })).map((e) => [e.id, e.agentVersion ?? 'unknown']));
    const fleetByVersion = new Map<string, number>();
    for (const v of versions.values()) fleetByVersion.set(v, (fleetByVersion.get(v) ?? 0) + 1);
    const stats: MonitorStats[] = monitors.map((m) => {
      const mine = eps7.filter((x) => x.ruleId === m.id);
      const byV = new Map<string, number>();
      for (const x of mine) { const v = versions.get(x.endpointId!) ?? 'unknown'; byV.set(v, (byV.get(v) ?? 0) + x._count); }
      const res = resolved7.filter((x) => x.ruleId === m.id);
      return {
        ruleId: m.id, key: m.key, name: m.name, kind: m.kind, severity: m.severity as Sev, enabled: m.enabled, params: (m.params ?? {}) as Record<string, unknown>, createdAt: m.createdAt, businessId: m.customerId,
        alerts7d: m7.get(m.id) ?? 0, alertsPrev7d: mP7.get(m.id) ?? 0, alerts30d: m30.get(m.id) ?? 0, alerts90d: m90.get(m.id) ?? 0, computers7d: mine.length,
        quickResolves7d: res.filter((x) => !x.resolvedById && x.resolvedAt && x.resolvedAt.getTime() - x.firstSeenAt.getTime() < 10 * 60_000).length, resolves7d: res.length,
        fpReports30d: mFp.get(m.id) ?? 0, informational30d: mInf.get(m.id) ?? 0,
        byAgentVersion: [...byV].map(([version, alerts]) => ({ version, alerts, computers: fleetByVersion.get(version) ?? 0 })),
      };
    });
    // One event raising alerts from more than one monitor on one computer, in the last week.
    const dupRows = await this.prisma.monitorEventFingerprint.groupBy({
      by: ['endpointId', 'fingerprint'], where: { lastSeenAt: { gte: ago(7) }, class: { not: 'BENIGN' }, ...(biz ? { customerId: biz } : {}) },
      _count: { ruleKey: true }, having: { ruleKey: { _count: { gt: 1 } } }, orderBy: [{ endpointId: 'asc' }, { fingerprint: 'asc' }], take: 50,
    });
    const visibleEps = new Set((await this.prisma.monitorAlert.findMany({ where: { AND: [aw, { endpointId: { in: dupRows.map((d) => d.endpointId) } }] }, select: { endpointId: true }, distinct: ['endpointId'], take: 50 })).map((x) => x.endpointId));
    const duplicates = [];
    for (const d of dupRows.filter((x) => visibleEps.has(x.endpointId))) {
      const keys = (await this.prisma.monitorEventFingerprint.findMany({ where: { endpointId: d.endpointId, fingerprint: d.fingerprint }, select: { ruleKey: true } })).map((x) => x.ruleKey);
      duplicates.push({ endpointId: d.endpointId, fingerprint: d.fingerprint, keys: [...new Set(keys)].sort() });
    }
    const rows = await this.prisma.alertQualityRule.findMany({ where: { AND: [this.ruleWhere(a, f), { status: 'active' }] }, take: 1000 });
    const rules = rows.flatMap((r) => {
      const m = RuleMatch.safeParse(r.match), b = RuleBehaviour.safeParse(r.behaviour);
      if (!m.success || !b.success) return [];
      const like: QualityRuleLike = { id: r.id, status: r.status, scopeKind: r.scopeKind as ScopeKind, customerId: r.customerId, endpointId: r.endpointId, groupId: r.groupId, monitorRuleId: r.monitorRuleId, osFamily: r.osFamily, ruleKey: r.ruleKey, match: m.data, behaviour: b.data, temporary: r.temporary, expiresAt: r.expiresAt };
      return [{ ...like, name: r.name, dangerousMatchCount: r.dangerousMatchCount, risk: r.risk, reviewAt: r.reviewAt, matchCount: r.matchCount }];
    });
    return { checks: qualityChecks({ monitors: stats, duplicates, rules }, now), monitorsChecked: stats.length, note: 'Recommendations only. Nothing here changes or disables a monitor.' };
  }
}
