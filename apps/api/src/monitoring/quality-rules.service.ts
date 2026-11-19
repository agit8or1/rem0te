import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, type AlertQualityRule, type MonitorAlert } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EmailService } from '../email/email.service';
import { activePause } from '../containment/pause';
import { GroupMembershipService } from '../group-policy/membership.service';
import { MonitoringService } from './monitoring.service';
import { MonitoringAdminService } from './monitoring-admin.service';
import { AlertEventsService } from './alert-events.service';
import { AlertQualityService } from './alert-quality.service';
import { QualityEngineService } from './quality-engine.service';
import {
  ApproveInput, CloseInput, canonicalMatch, expiryProblem, matchKeyOf, narrownessProblem, osFamilyOf, riskOf, RuleBehaviour, RuleDraftInput, RuleEditInput, RuleMatch,
  scopeKeyFor, SIMULATION_DAYS, SIMULATION_FRESH_MS, simulateRule,
  type HistoricAlert, type HistoricEvent, type QualityRuleLike, type RuleContext, type RuleScopeInput, type ScopeKind, type SimulationResult,
} from './quality-rules';

type Sev = 'INFO' | 'WARNING' | 'CRITICAL';
const SEV_RANK: Record<Sev, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
/** How many alerts, and recorded events, a simulation reads at most. */
const SIM_LIMIT = 5_000;
/** How many open alerts an approval reclassifies at once (the rest follow on their next report). */
const APPLY_LIMIT = 2_000;

type Resolved = {
  kind: ScopeKind; customerId: string | null; tenantId: string | null; endpointId: string | null; groupId: string | null; monitorRuleId: string | null; osFamily: string | null;
  monitor: { id: string; key: string; name: string; kind: string; severity: Sev; params: Record<string, unknown> };
};

/**
 * Alert quality rules (0.67), the managing half: propose, edit while pending,
 * test against stored history, approve, reject, roll back, expire. Every
 * change is audited and kept in the rule's own history; nothing is deleted.
 *
 *   - A rule is proposed `pending`. A pending rule is evaluated in the shadow
 *     (counted on every report, never applied).
 *   - It is approved only after a simulation of its current revision, under
 *     a week old. Dangerous matches (events the classifier knows as genuine
 *     failures, Security-log events) need `acceptDangerous` and make the rule
 *     high risk.
 *   - A high-risk rule needs two different approvers. The CHECK in 0086 holds
 *     it too.
 *   - Approving needs fresh authentication (`monitoring.qualityrule`, in the
 *     controller); rejecting and rolling back never do — they only ever bring
 *     alerts back.
 *   - Platform, OS-wide and global-monitor rules are a Platform Admin's. A
 *     business's rules need monitoring:configure for that whole business.
 *   - An approval reclassifies the open alerts the rule covers, through the
 *     same path as the classifier's (AlertQualityService.reclassifyOne), each
 *     audited. A rollback changes the future only; closed alerts stay closed.
 */
@Injectable()
export class QualityRulesService implements OnModuleInit {
  private readonly logger = new Logger('AlertQualityRules');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly admin: MonitoringAdminService,
    private readonly mon: MonitoringService,
    private readonly engine: QualityEngineService,
    private readonly aq: AlertQualityService,
    private readonly events: AlertEventsService,
    private readonly email: EmailService,
    private readonly groups: GroupMembershipService,
  ) {}

  /** Expiry and review reminders run inside the monitoring sweep (MONITOR_SWEEP=off stops them with it). */
  onModuleInit() { this.mon.addSweepStep('quality-rules', (now) => this.expiryPass(now)); }

  // ── Who ───────────────────────────────────────────────────────────────────

  private platformOnly(a: ActorContext) {
    if (!a.isPlatformAdmin || a.technician) throw new ForbiddenException({ code: 'PLATFORM_ADMIN_ONLY', message: 'A rule for every business (the platform, an OS everywhere, or a global monitor) is a Platform Admin\'s.' });
  }

  /** May this person see a rule about this business (null: a platform rule, which everyone with alerts sees)? 404 otherwise. */
  private assertVisible(a: ActorContext, customerId: string | null) {
    this.admin.alertWhere(a); // 403 without monitoring:alerts
    if (customerId === null || a.isPlatformAdmin || this.admin.isMsp(a)) return;
    const mine = a.technician?.businessId ?? a.businessId;
    if (mine !== customerId) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
  }

  /** May this person change a rule in this scope? Resolves the scope and its monitor. */
  private async resolveScope(a: ActorContext, s: RuleScopeInput, ruleKey: string): Promise<Resolved> {
    let customerId: string | null = null, endpointId: string | null = null, groupId: string | null = null, monitorRuleId: string | null = null, osFamily: string | null = null;
    const need = (v: string | undefined, what: string) => { if (!v) throw new BadRequestException({ code: 'INVALID_REQUEST', message: `scope: ${what} is required` }); return v; };
    switch (s.kind) {
      case 'endpoint': {
        const ep = await this.acl.assertEndpointInScope(a, need(s.endpointId, 'endpointId'), CAP.MONITORING_CONFIGURE);
        if (!ep.customerId) throw new BadRequestException({ code: 'ENDPOINT_UNASSIGNED', message: 'This computer is not in a business.' });
        customerId = ep.customerId; endpointId = ep.id;
        break;
      }
      case 'group': {
        const g = await this.prisma.endpointGroup.findUnique({ where: { id: need(s.groupId, 'groupId') }, select: { id: true, customerId: true } });
        if (!g?.customerId) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Group not found' });
        this.assertVisible(a, g.customerId);
        customerId = g.customerId; groupId = g.id;
        break;
      }
      case 'business': customerId = need(s.businessId, 'businessId'); break;
      case 'os': customerId = s.businessId ?? null; osFamily = need(s.osFamily, 'osFamily'); break;
      case 'monitor': {
        const m = await this.prisma.monitorRule.findUnique({ where: { id: need(s.monitorRuleId, 'monitorRuleId') }, select: { id: true, customerId: true, key: true } });
        if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Monitor not found' });
        if (m.customerId) this.assertVisible(a, m.customerId);
        if (m.key !== ruleKey) throw new BadRequestException({ code: 'MONITOR_MISMATCH', message: 'The rule names a different monitor from its scope.' });
        customerId = m.customerId; monitorRuleId = m.id;
        break;
      }
      default: break;
    }
    if (customerId === null) this.platformOnly(a);
    else this.admin.assertConfigure(a, customerId);
    const tenantId = customerId ? (await this.prisma.customer.findUnique({ where: { id: customerId }, select: { tenantId: true } }))?.tenantId ?? null : null;
    if (customerId && !tenantId) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Business not found' });
    // The monitor the rule is about: this one row (monitor scope), or the business's own, or the global one.
    // A rule for every business is judged against every monitor with that key: the most severe decides
    // its risk, and they must all be the same kind.
    const monitors = await this.prisma.monitorRule.findMany({
      where: monitorRuleId ? { id: monitorRuleId } : customerId ? { key: ruleKey, OR: [{ customerId: null }, { customerId }] } : { key: ruleKey },
      orderBy: [{ customerId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }], take: 500,
      select: { id: true, key: true, name: true, kind: true, severity: true, params: true },
    });
    if (!monitors.length) throw new NotFoundException({ code: 'MONITOR_NOT_FOUND', message: `No monitor "${ruleKey}" applies here.` });
    if (new Set(monitors.map((m) => m.kind)).size > 1) throw new BadRequestException({ code: 'MONITOR_KIND_MIXED', message: `Monitors named "${ruleKey}" are of different kinds; scope the rule to one business or one monitor.` });
    const monitor = customerId || monitorRuleId ? monitors[0] : [...monitors].sort((x, y) => SEV_RANK[y.severity as Sev] - SEV_RANK[x.severity as Sev])[0];
    return { kind: s.kind, customerId, tenantId, endpointId, groupId, monitorRuleId, osFamily, monitor: { ...monitor, severity: monitor.severity as Sev, params: monitor.params as Record<string, unknown> } };
  }

  private scopeInputOf(r: AlertQualityRule): RuleScopeInput {
    return {
      kind: r.scopeKind as ScopeKind,
      ...(r.customerId && r.scopeKind !== 'endpoint' && r.scopeKind !== 'group' && r.scopeKind !== 'monitor' ? { businessId: r.customerId } : {}),
      ...(r.endpointId ? { endpointId: r.endpointId } : {}), ...(r.groupId ? { groupId: r.groupId } : {}),
      ...(r.monitorRuleId ? { monitorRuleId: r.monitorRuleId } : {}), ...(r.osFamily ? { osFamily: r.osFamily as RuleScopeInput['osFamily'] } : {}),
    };
  }

  private async load(a: ActorContext, id: string) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
    const r = await this.prisma.alertQualityRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
    this.assertVisible(a, r.customerId);
    return r;
  }

  /** Change rights over an existing rule: its scope again, as the caller, today. */
  private async assertManage(a: ActorContext, r: AlertQualityRule) { return this.resolveScope(a, this.scopeInputOf(r), r.ruleKey); }

  // ── Read ──────────────────────────────────────────────────────────────────

  private async names(rows: AlertQualityRule[]) {
    const ids = (k: 'customerId' | 'endpointId' | 'groupId') => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
    const users = [...new Set(rows.flatMap((r) => [r.createdById, r.approvedById, r.secondApprovedById, r.rejectedById, r.rolledBackById]).filter((x): x is string => !!x))];
    const [b, e, g, u] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: ids('customerId') } }, select: { id: true, name: true } }),
      this.prisma.endpoint.findMany({ where: { id: { in: ids('endpointId') } }, select: { id: true, name: true, hostname: true } }),
      this.prisma.endpointGroup.findMany({ where: { id: { in: ids('groupId') } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: users } }, select: { id: true, email: true } }),
    ]);
    return { b: new Map(b.map((x) => [x.id, x.name])), e: new Map(e.map((x) => [x.id, x.name ?? x.hostname ?? x.id])), g: new Map(g.map((x) => [x.id, x.name])), u: new Map(u.map((x) => [x.id, x.email])) };
  }

  view(r: AlertQualityRule, n: Awaited<ReturnType<QualityRulesService['names']>>, a: ActorContext, now = new Date()) {
    const sim = r.simulation as unknown as SimulationResult | null;
    const scopeLabel = r.scopeKind === 'endpoint' ? `Computer ${n.e.get(r.endpointId!) ?? ''}` : r.scopeKind === 'group' ? `Group ${n.g.get(r.groupId!) ?? ''}`
      : r.scopeKind === 'business' ? `Business ${n.b.get(r.customerId!) ?? ''}` : r.scopeKind === 'monitor' ? 'This monitor' + (r.customerId ? ` (${n.b.get(r.customerId) ?? ''})` : ' (global)')
        : r.scopeKind === 'os' ? `${r.osFamily}${r.customerId ? ` in ${n.b.get(r.customerId) ?? ''}` : ' everywhere'}` : 'Every business (platform)';
    const expired = r.status === 'active' && r.temporary && !!r.expiresAt && r.expiresAt <= now;
    return {
      id: r.id, name: r.name, description: r.description, justification: r.justification,
      scope: { kind: r.scopeKind, key: r.scopeKey, label: scopeLabel.trim(), businessId: r.customerId, business: r.customerId ? n.b.get(r.customerId) ?? null : null, endpointId: r.endpointId, groupId: r.groupId, monitorRuleId: r.monitorRuleId, osFamily: r.osFamily },
      monitor: r.ruleKey, match: r.match, behaviour: r.behaviour,
      temporary: r.temporary, expiresAt: r.expiresAt, reviewAt: r.reviewAt, reviewOverdue: !r.temporary && r.status === 'active' && !!r.reviewAt && r.reviewAt <= now,
      status: expired ? 'expired' : r.status, revision: r.revision, risk: r.risk, riskReasons: r.riskReasons, allowBroad: r.allowBroad,
      simulation: sim ? { ...sim, current: r.simulatedRevision === r.revision && !!r.simulatedAt && now.getTime() - r.simulatedAt.getTime() < SIMULATION_FRESH_MS } : null,
      createdBy: n.u.get(r.createdById) ?? r.createdById, createdAt: r.createdAt,
      approvedBy: r.approvedById ? n.u.get(r.approvedById) ?? r.approvedById : null, approvedAt: r.approvedAt,
      secondApprovedBy: r.secondApprovedById ? n.u.get(r.secondApprovedById) ?? r.secondApprovedById : null, secondApprovedAt: r.secondApprovedAt,
      awaitingSecondApproval: r.status === 'pending' && r.risk === 'high' && !!r.approvedById,
      mayApproveSecond: r.status === 'pending' && r.risk === 'high' && !!r.approvedById && r.approvedById !== a.userId,
      rejectedBy: r.rejectedById ? n.u.get(r.rejectedById) ?? r.rejectedById : null, rejectedAt: r.rejectedAt,
      rolledBackBy: r.rolledBackById ? n.u.get(r.rolledBackById) ?? r.rolledBackById : null, rolledBackAt: r.rolledBackAt, closedNote: r.closedNote,
      supersedesId: r.supersedesId, recommendationId: r.recommendationId,
      matchCount: r.matchCount, lastMatchedAt: r.lastMatchedAt, shadowMatchCount: r.shadowMatchCount, shadowLastMatchedAt: r.shadowLastMatchedAt, dangerousMatchCount: r.dangerousMatchCount,
    };
  }

  async list(a: ActorContext, q: Record<string, unknown>) {
    const businessId = typeof q.businessId === 'string' && q.businessId ? q.businessId : undefined;
    this.admin.alertWhere(a, businessId);
    const scope = this.acl.resolveScope(a, businessId);
    const status = typeof q.status === 'string' && ['pending', 'active', 'rejected', 'rolled_back', 'expired', 'superseded'].includes(q.status) ? q.status : undefined;
    const mine = a.isPlatformAdmin || this.admin.isMsp(a) ? (scope ? { OR: [{ customerId: scope }, { customerId: null }] } : {}) : { OR: [{ customerId: a.technician?.businessId ?? scope ?? '-' }, { customerId: null }] };
    const rows = await this.prisma.alertQualityRule.findMany({
      where: { AND: [mine, ...(status ? [{ status }] : []), ...(typeof q.monitor === 'string' && q.monitor ? [{ ruleKey: q.monitor }] : [])] },
      orderBy: [{ updatedAt: 'desc' }], take: 500,
    });
    const n = await this.names(rows);
    return { rules: rows.map((r) => this.view(r, n, a)) };
  }

  async get(a: ActorContext, id: string) {
    const r = await this.load(a, id);
    const [events, chain] = await Promise.all([
      this.prisma.alertQualityRuleEvent.findMany({ where: { ruleId: r.id }, orderBy: { createdAt: 'asc' }, take: 500 }),
      this.prisma.alertQualityRule.findMany({ where: { OR: [{ id: r.supersedesId ?? '-' }, { supersedesId: r.id }] }, select: { id: true, name: true, status: true, revision: true, supersedesId: true, createdAt: true } }),
    ]);
    const n = await this.names([r]);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))] } }, select: { id: true, email: true } });
    const um = new Map(users.map((u) => [u.id, u.email]));
    let mayManage = false;
    try { await this.assertManage(a, r); mayManage = true; } catch { /* read-only */ }
    return {
      ...this.view(r, n, a), mayManage,
      history: events.map((e) => ({ id: e.id, type: e.type, by: e.actorId ? um.get(e.actorId) ?? e.actorId : null, revision: e.revision, at: e.createdAt, detail: e.detail, snapshot: e.snapshot })),
      versions: chain.map((c) => ({ ...c, relation: c.id === r.supersedesId ? 'previous' : 'next' })),
    };
  }

  // ── Propose and edit ──────────────────────────────────────────────────────

  private snapshot(r: Pick<AlertQualityRule, 'name' | 'description' | 'justification' | 'scopeKey' | 'ruleKey' | 'match' | 'behaviour' | 'temporary' | 'expiresAt' | 'reviewAt' | 'allowBroad' | 'revision'>) {
    return { name: r.name, description: r.description, justification: r.justification, scopeKey: r.scopeKey, ruleKey: r.ruleKey, match: r.match, behaviour: r.behaviour, temporary: r.temporary, expiresAt: r.expiresAt, reviewAt: r.reviewAt, allowBroad: r.allowBroad, revision: r.revision } as Prisma.InputJsonValue;
  }

  /** Validate a draft against its scope and monitor. Throws with the reason. */
  private async check(a: ActorContext, d: RuleDraftInput, now: Date) {
    if (d.match.ruleKey === undefined) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'match.ruleKey is required' });
    if (d.allowBroad && (!a.isPlatformAdmin || a.technician)) throw new ForbiddenException({ code: 'PLATFORM_ADMIN_ONLY', message: 'Only a Platform Admin can make an exception to the narrowness rules.' });
    const s = await this.resolveScope(a, d.scope, d.match.ruleKey);
    const np = narrownessProblem({ scope: d.scope, match: d.match, behaviour: d.behaviour, allowBroad: d.allowBroad }, s.monitor.kind);
    if (np) throw new BadRequestException(np);
    const ep = expiryProblem(d, now);
    if (ep) throw new BadRequestException(ep);
    const match = canonicalMatch(d.match);
    const risk = riskOf({ scope: { kind: d.scope.kind, businessId: s.customerId }, match, behaviour: d.behaviour, allowBroad: d.allowBroad },
      { kind: s.monitor.kind, severity: s.monitor.severity, key: s.monitor.key, name: s.monitor.name, log: typeof s.monitor.params.log === 'string' ? s.monitor.params.log : null });
    return { s, match, risk };
  }

  async create(a: ActorContext, raw: unknown, now = new Date()) {
    const p = RuleDraftInput.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const d = p.data;
    const { s, match, risk } = await this.check(a, d, now);
    let supersedes: AlertQualityRule | null = null;
    if (d.supersedesId) {
      supersedes = await this.load(a, d.supersedesId);
      if (supersedes.status !== 'active') throw new ConflictException({ code: 'NOT_ACTIVE', message: 'Only an active rule can be revised.' });
      await this.assertManage(a, supersedes);
      if (supersedes.ruleKey !== match.ruleKey) throw new BadRequestException({ code: 'MONITOR_MISMATCH', message: 'A revision is about the same monitor.' });
    }
    let rec: { id: string; customerId: string | null } | null = null;
    if (d.recommendationId) {
      rec = await this.prisma.alertRuleRecommendation.findUnique({ where: { id: d.recommendationId }, select: { id: true, customerId: true, status: true, ruleKey: true } })
        .then((x) => (x && x.status === 'open' && x.ruleKey === match.ruleKey ? x : null));
      if (!rec) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recommendation not found, or no longer open.' });
      this.assertVisible(a, rec.customerId);
    }
    const scopeKey = scopeKeyFor({ kind: d.scope.kind, customerId: s.customerId, endpointId: s.endpointId, groupId: s.groupId, monitorRuleId: s.monitorRuleId, osFamily: s.osFamily });
    const data = {
      tenantId: s.tenantId, customerId: s.customerId, scopeKind: d.scope.kind, scopeKey, endpointId: s.endpointId, groupId: s.groupId, monitorRuleId: s.monitorRuleId, osFamily: s.osFamily,
      name: d.name, description: d.description, justification: d.justification, ruleKey: match.ruleKey, match: match as Prisma.InputJsonValue, matchKey: matchKeyOf(match),
      behaviour: d.behaviour as Prisma.InputJsonValue, behaviourKind: d.behaviour.kind, temporary: d.temporary,
      expiresAt: d.temporary ? new Date(d.expiresAt!) : null, reviewAt: d.temporary ? null : new Date(d.reviewAt!), risk: risk.risk, riskReasons: risk.reasons as Prisma.InputJsonValue,
      allowBroad: d.allowBroad, createdById: a.userId, supersedesId: supersedes?.id ?? null, recommendationId: rec?.id ?? null,
    };
    const r = await this.prisma.$transaction(async (tx) => {
      const r = await tx.alertQualityRule.create({ data });
      await tx.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'proposed', actorId: a.userId, revision: 1, snapshot: this.snapshot(r), detail: { risk: risk.risk, riskReasons: risk.reasons, supersedes: supersedes?.id ?? null, recommendation: rec?.id ?? null } } });
      if (rec) {
        const u = await tx.alertRuleRecommendation.updateMany({ where: { id: rec.id, status: 'open' }, data: { status: 'converted', qualityRuleId: r.id } });
        if (!u.count) throw new ConflictException({ code: 'RECOMMENDATION_CHANGED', message: 'That recommendation was just changed by someone else.' });
      }
      return r;
    });
    await this.audit.log({
      action: 'ALERT_QUALITY_RULE_PROPOSED', actorId: a.userId, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id,
      meta: { scope: scopeKey, monitor: match.ruleKey, behaviour: d.behaviour.kind, risk: risk.risk, riskReasons: risk.reasons, temporary: d.temporary, supersedes: supersedes?.id ?? null, recommendation: rec?.id ?? null },
    });
    this.engine.invalidate();
    if (risk.risk === 'high') void this.notifyAdmins(r, 'proposed_high_risk');
    return this.get(a, r.id);
  }

  async edit(a: ActorContext, id: string, raw: unknown, now = new Date()) {
    const p = RuleEditInput.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const r = await this.load(a, id);
    if (r.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: 'Only a pending rule can be edited. Revise an active rule instead: the revision replaces it when approved.' });
    if (p.data.revision !== r.revision) throw new ConflictException({ code: 'STALE_REVISION', message: 'Someone changed this rule since you opened it. Reload it.' });
    await this.assertManage(a, r);
    const cur = RuleDraftInput.parse({
      name: r.name, description: r.description, justification: r.justification, scope: this.scopeInputOf(r), match: r.match, behaviour: r.behaviour, temporary: r.temporary,
      ...(r.expiresAt ? { expiresAt: r.expiresAt.toISOString() } : {}), ...(r.reviewAt ? { reviewAt: r.reviewAt.toISOString() } : {}), allowBroad: r.allowBroad,
    });
    const { revision: _rev, ...patch } = p.data;
    const next = { ...cur, ...patch } as RuleDraftInput;
    if (patch.temporary === true) delete next.reviewAt;
    if (patch.temporary === false) delete next.expiresAt;
    const { s, match, risk } = await this.check(a, next, now);
    const scopeKey = scopeKeyFor({ kind: next.scope.kind, customerId: s.customerId, endpointId: s.endpointId, groupId: s.groupId, monitorRuleId: s.monitorRuleId, osFamily: s.osFamily });
    const u = await this.prisma.$transaction(async (tx) => {
      const u = await tx.alertQualityRule.updateMany({
        where: { id: r.id, status: 'pending', revision: r.revision },
        data: {
          tenantId: s.tenantId, customerId: s.customerId, scopeKind: next.scope.kind, scopeKey, endpointId: s.endpointId, groupId: s.groupId, monitorRuleId: s.monitorRuleId, osFamily: s.osFamily,
          name: next.name, description: next.description, justification: next.justification, ruleKey: match.ruleKey, match: match as Prisma.InputJsonValue, matchKey: matchKeyOf(match),
          behaviour: next.behaviour as Prisma.InputJsonValue, behaviourKind: next.behaviour.kind, temporary: next.temporary,
          expiresAt: next.temporary ? new Date(next.expiresAt!) : null, reviewAt: next.temporary ? null : new Date(next.reviewAt!),
          risk: risk.risk, riskReasons: risk.reasons as Prisma.InputJsonValue, allowBroad: next.allowBroad,
          // A changed rule is a new text: its simulation and any first approval no longer apply.
          revision: { increment: 1 }, simulation: Prisma.DbNull, simulatedRevision: null, simulatedAt: null, approvedById: null, approvedAt: null,
        },
      });
      if (u.count) await tx.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'edited', actorId: a.userId, revision: r.revision + 1, snapshot: this.snapshot(r), detail: { previousRevision: r.revision } } });
      return u;
    });
    if (!u.count) throw new ConflictException({ code: 'STALE_REVISION', message: 'Someone changed this rule since you opened it. Reload it.' });
    await this.audit.log({
      action: 'ALERT_QUALITY_RULE_EDITED', actorId: a.userId, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id,
      meta: { revision: r.revision + 1, scope: scopeKey, monitor: match.ruleKey, behaviour: next.behaviour.kind, risk: risk.risk, firstApprovalVoided: !!r.approvedById },
    });
    this.engine.invalidate();
    return this.get(a, r.id);
  }

  // ── Test against stored history ───────────────────────────────────────────

  /** The stored history a rule could touch: alerts and recorded events, last 90 days, for its monitor and business (all, for a platform rule). */
  private async history(rule: QualityRuleLike, now: Date) {
    const since = new Date(now.getTime() - SIMULATION_DAYS * 86_400_000);
    const biz = rule.customerId ? { customerId: rule.customerId } : {};
    const [alerts, events] = await Promise.all([
      this.prisma.monitorAlert.findMany({
        where: { ruleKey: rule.ruleKey, firstSeenAt: { gte: since }, endpointId: { not: null }, ...biz, ...(rule.endpointId ? { endpointId: rule.endpointId } : {}) },
        orderBy: { firstSeenAt: 'desc' }, take: SIM_LIMIT + 1,
        select: { id: true, title: true, customerId: true, endpointId: true, ruleKey: true, ruleId: true, kind: true, severity: true, state: true, firstSeenAt: true, detail: true, classification: true },
      }),
      this.prisma.monitorEventFingerprint.findMany({
        where: { ruleKey: rule.ruleKey, lastSeenAt: { gte: since }, ...biz, ...(rule.endpointId ? { endpointId: rule.endpointId } : {}) },
        orderBy: { lastSeenAt: 'desc' }, take: SIM_LIMIT + 1,
        select: { endpointId: true, ruleKey: true, fingerprint: true, class: true, seen: true, sample: true, log: true, customerId: true },
      }),
    ]);
    const truncated = alerts.length > SIM_LIMIT || events.length > SIM_LIMIT;
    const al = alerts.slice(0, SIM_LIMIT), evs = events.slice(0, SIM_LIMIT);
    const epIds = [...new Set([...al.map((x) => x.endpointId!), ...evs.map((x) => x.endpointId)])];
    const eps = await this.prisma.endpoint.findMany({ where: { id: { in: epIds } }, select: { id: true, customerId: true, platform: true, osVersion: true } });
    const epm = new Map(eps.map((e) => [e.id, e]));
    const groupsOf = rule.scopeKind === 'group' && rule.groupId ? await this.groups.snapshot([rule.groupId], epIds) : null;
    const monitorIds = [...new Set(al.map((x) => x.ruleId).filter((x): x is string => !!x))];
    const monitors = new Map((await this.prisma.monitorRule.findMany({ where: { id: { in: monitorIds } }, select: { id: true, severity: true, params: true } })).map((m) => [m.id, m]));
    const ctxOf = (endpointId: string, monitorRuleId: string | null): RuleContext | null => {
      const e = epm.get(endpointId);
      if (!e) return null;
      return { endpointId, customerId: e.customerId, groupIds: groupsOf?.groupsOf(endpointId) ?? new Set(), osFamily: osFamilyOf(e.platform, e.osVersion), ruleKey: rule.ruleKey, monitorRuleId };
    };
    const ha: HistoricAlert[] = al.map((x) => {
      const m = x.ruleId ? monitors.get(x.ruleId) : undefined;
      const d = (x.detail && typeof x.detail === 'object' ? x.detail : {}) as Record<string, unknown>;
      const params = (m?.params as Record<string, unknown> | undefined) ?? { log: d.log };
      return {
        id: x.id, title: x.title, customerId: x.customerId, endpointId: x.endpointId, ruleKey: x.ruleKey, ruleId: x.ruleId, kind: x.kind, severity: x.severity as Sev, state: x.state,
        firstSeenAt: x.firstSeenAt, detail: x.detail, classification: x.classification, log: typeof params.log === 'string' ? params.log : typeof d.log === 'string' ? d.log : null,
        ruleSeverity: (m?.severity as Sev | undefined) ?? (x.severity as Sev), ruleParams: params, ctx: ctxOf(x.endpointId!, x.ruleId),
      };
    });
    const he: HistoricEvent[] = evs.map((x) => ({ endpointId: x.endpointId, ruleKey: x.ruleKey, fingerprint: x.fingerprint, class: x.class, seen: x.seen, sample: x.sample, log: x.log, ctx: ctxOf(x.endpointId, rule.monitorRuleId) }));
    return { ha, he, truncated };
  }

  private like(r: AlertQualityRule): QualityRuleLike {
    return { id: r.id, status: r.status, scopeKind: r.scopeKind as ScopeKind, customerId: r.customerId, endpointId: r.endpointId, groupId: r.groupId, monitorRuleId: r.monitorRuleId, osFamily: r.osFamily, ruleKey: r.ruleKey, match: RuleMatch.parse(r.match), behaviour: RuleBehaviour.parse(r.behaviour), temporary: r.temporary, expiresAt: r.expiresAt };
  }

  /** Run and store a simulation of the rule's current revision. Re-decides the risk with what it found. */
  async simulate(a: ActorContext, id: string, now = new Date()) {
    const r = await this.load(a, id);
    if (r.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: 'Only a pending rule is tested before approval.' });
    const s = await this.assertManage(a, r);
    const like = this.like(r);
    const { ha, he, truncated } = await this.history(like, now);
    const res = simulateRule(like, r.revision, ha, he, now, truncated);
    const risk = riskOf({ scope: { kind: like.scopeKind, businessId: r.customerId }, match: like.match, behaviour: like.behaviour, allowBroad: r.allowBroad },
      { kind: s.monitor.kind, severity: s.monitor.severity, key: s.monitor.key, name: s.monitor.name, log: typeof s.monitor.params.log === 'string' ? s.monitor.params.log : null }, res.dangerous.length);
    const becameHigh = r.risk !== 'high' && risk.risk === 'high';
    const u = await this.prisma.alertQualityRule.updateMany({
      where: { id: r.id, status: 'pending', revision: r.revision },
      data: { simulation: res as unknown as Prisma.InputJsonValue, simulatedRevision: r.revision, simulatedAt: now, risk: risk.risk, riskReasons: risk.reasons as Prisma.InputJsonValue },
    });
    if (!u.count) throw new ConflictException({ code: 'STALE_REVISION', message: 'Someone changed this rule while it was being tested. Test it again.' });
    await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'simulated', actorId: a.userId, revision: r.revision, detail: { considered: res.considered, matched: res.matched, wouldSuppress: res.wouldSuppress, wouldDowngrade: res.wouldDowngrade, dangerous: res.dangerous.length, truncated, risk: risk.risk } } });
    if (becameHigh && r.approvedById === null) void this.notifyAdmins({ ...r, risk: 'high' }, 'proposed_high_risk');
    return this.get(a, r.id);
  }

  /** A simulation of a draft that is not stored (a recommendation's "Preview matching events"). */
  async simulateDraft(a: ActorContext, draft: { scope: RuleScopeInput; match: RuleMatch; behaviour: RuleBehaviour }, now = new Date()) {
    const s = await this.resolveScope(a, draft.scope, draft.match.ruleKey);
    const like: QualityRuleLike = { id: 'draft', status: 'pending', scopeKind: draft.scope.kind, customerId: s.customerId, endpointId: s.endpointId, groupId: s.groupId, monitorRuleId: s.monitorRuleId, osFamily: s.osFamily, ruleKey: draft.match.ruleKey, match: canonicalMatch(draft.match), behaviour: draft.behaviour, temporary: false, expiresAt: null };
    const { ha, he, truncated } = await this.history(like, now);
    return simulateRule(like, 0, ha, he, now, truncated);
  }

  // ── Approve, reject, roll back ────────────────────────────────────────────

  async approve(a: ActorContext, id: string, raw: unknown, fresh: () => void, now = new Date()) {
    const p = ApproveInput.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const r = await this.load(a, id);
    if (r.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: 'This rule is not awaiting approval.' });
    if (p.data.revision !== r.revision) throw new ConflictException({ code: 'STALE_REVISION', message: 'Someone changed this rule since you opened it. Reload it.' });
    await this.assertManage(a, r);
    const sim = r.simulation as unknown as SimulationResult | null;
    if (!sim || r.simulatedRevision !== r.revision || !r.simulatedAt || now.getTime() - r.simulatedAt.getTime() > SIMULATION_FRESH_MS) {
      throw new ConflictException({ code: 'SIMULATION_REQUIRED', message: 'Test this rule against stored history first (Test proposed rule). A rule is not approved on its description alone.' });
    }
    if (sim.dangerous.length && !p.data.acceptDangerous) {
      throw new ConflictException({ code: 'DANGEROUS_MATCHES', message: `The test found ${sim.dangerous.length} match${sim.dangerous.length === 1 ? '' : 'es'} the classifier knows as genuine failures (or Security-log events). Read them, and confirm you accept them, to approve.`, dangerous: sim.dangerous.slice(0, 10) });
    }
    const ep = expiryProblem({ temporary: r.temporary, expiresAt: r.expiresAt, reviewAt: r.reviewAt }, now);
    if (ep) throw new ConflictException(ep);
    if (r.risk === 'high' && r.approvedById === a.userId) {
      throw new ConflictException({ code: 'SECOND_APPROVER_REQUIRED', message: 'This rule could hide a critical, security or backup failure, or reaches every business: a second, different person must approve it.' });
    }
    // Confirm it is you (monitoring.qualityrule): after scope and every check, before the first write.
    fresh();

    // A high-risk rule: the first approval is recorded and the rule waits for a second, different person.
    if (r.risk === 'high' && !r.approvedById) {
      const u = await this.prisma.alertQualityRule.updateMany({ where: { id: r.id, status: 'pending', revision: r.revision, approvedById: null }, data: { approvedById: a.userId, approvedAt: now } });
      if (!u.count) throw new ConflictException({ code: 'STALE_REVISION', message: 'Someone changed or approved this rule at the same moment. Reload it.' });
      await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'second_approval_needed', actorId: a.userId, revision: r.revision, detail: { riskReasons: r.riskReasons, acceptDangerous: p.data.acceptDangerous } } });
      await this.audit.log({ action: 'ALERT_QUALITY_RULE_APPROVED', actorId: a.userId, tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id,
        meta: { step: 'first', of: 2, revision: r.revision, risk: r.risk, acceptDangerous: p.data.acceptDangerous, dangerous: sim.dangerous.length } });
      void this.notifyAdmins(r, 'second_approval_needed');
      return this.get(a, r.id);
    }
    const second = r.risk === 'high';
    try {
      await this.prisma.$transaction(async (tx) => {
        if (r.supersedesId) {
          const s = await tx.alertQualityRule.updateMany({ where: { id: r.supersedesId, status: 'active' }, data: { status: 'superseded' } });
          if (s.count) await tx.alertQualityRuleEvent.create({ data: { ruleId: r.supersedesId, type: 'superseded', actorId: a.userId, revision: 0, detail: { by: r.id } } });
        }
        const u = await tx.alertQualityRule.updateMany({
          where: { id: r.id, status: 'pending', revision: r.revision, ...(second ? { approvedById: r.approvedById } : { approvedById: null }) },
          data: second ? { status: 'active', secondApprovedById: a.userId, secondApprovedAt: now } : { status: 'active', approvedById: a.userId, approvedAt: now },
        });
        if (!u.count) throw new ConflictException({ code: 'STALE_REVISION', message: 'Someone changed or approved this rule at the same moment. Reload it.' });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'RULE_CONFLICT', message: 'An active rule with the same scope and conditions already exists. Revise that one instead.' });
      throw e;
    }
    this.engine.invalidate();
    const applied = await this.applyToOpen(r, now).catch((e) => { this.logger.warn(`apply ${r.id}: ${(e as Error).message}`); return { checked: 0, changed: 0, closed: 0 }; });
    await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'approved', actorId: a.userId, revision: r.revision, detail: { step: second ? 'second' : 'only', acceptDangerous: p.data.acceptDangerous, applied } } });
    await this.audit.log({ action: 'ALERT_QUALITY_RULE_APPROVED', actorId: a.userId, tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id,
      meta: { step: second ? 'second' : 'only', revision: r.revision, risk: r.risk, scope: r.scopeKey, monitor: r.ruleKey, behaviour: r.behaviourKind, acceptDangerous: p.data.acceptDangerous, dangerous: sim.dangerous.length, supersedes: r.supersedesId, applied } });
    void this.notifyAdmins(r, 'approved', applied);
    return this.get(a, r.id);
  }

  async reject(a: ActorContext, id: string, raw: unknown, now = new Date()) {
    const p = CloseInput.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const r = await this.load(a, id);
    await this.assertManage(a, r);
    const u = await this.prisma.alertQualityRule.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'rejected', rejectedById: a.userId, rejectedAt: now, closedNote: p.data.note } });
    if (!u.count) throw new ConflictException({ code: 'NOT_PENDING', message: 'This rule is not awaiting approval.' });
    await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'rejected', actorId: a.userId, revision: r.revision, detail: { note: p.data.note } } });
    await this.audit.log({ action: 'ALERT_QUALITY_RULE_REJECTED', actorId: a.userId, tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id, meta: { revision: r.revision, scope: r.scopeKey, monitor: r.ruleKey } });
    if (r.recommendationId) await this.prisma.alertRuleRecommendation.updateMany({ where: { id: r.recommendationId, status: 'converted', qualityRuleId: r.id }, data: { status: 'open', qualityRuleId: null } }).catch(() => undefined);
    this.engine.invalidate();
    return this.get(a, r.id);
  }

  /**
   * Immediate: the rule stops applying now. When it superseded another rule,
   * that one is active again (the previous version). Alerts it closed stay
   * closed; the next matching event raises as before. Never asks for fresh
   * authentication — it only ever brings alerts back.
   */
  async rollback(a: ActorContext, id: string, raw: unknown, now = new Date()) {
    const p = CloseInput.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const r = await this.load(a, id);
    await this.assertManage(a, r);
    let restored: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.alertQualityRule.updateMany({ where: { id: r.id, status: 'active' }, data: { status: 'rolled_back', rolledBackById: a.userId, rolledBackAt: now, closedNote: p.data.note } });
      if (!u.count) throw new ConflictException({ code: 'NOT_ACTIVE', message: 'This rule is not active.' });
      await tx.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'rolled_back', actorId: a.userId, revision: r.revision, detail: { note: p.data.note } } });
      if (r.supersedesId) {
        const prev = await tx.alertQualityRule.findUnique({ where: { id: r.supersedesId }, select: { id: true, status: true, temporary: true, expiresAt: true } });
        // The previous version comes back only if it was superseded (not rolled back itself) and has not expired.
        if (prev && prev.status === 'superseded' && !(prev.temporary && prev.expiresAt && prev.expiresAt <= now)) {
          await tx.alertQualityRule.update({ where: { id: prev.id }, data: { status: 'active' } });
          await tx.alertQualityRuleEvent.create({ data: { ruleId: prev.id, type: 'restored', actorId: a.userId, revision: 0, detail: { after: r.id } } });
          restored = prev.id;
        }
      }
    });
    await this.audit.log({ action: 'ALERT_QUALITY_RULE_ROLLED_BACK', actorId: a.userId, tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id,
      meta: { revision: r.revision, scope: r.scopeKey, monitor: r.ruleKey, behaviour: r.behaviourKind, restored, matchCount: r.matchCount } });
    this.engine.invalidate();
    void this.notifyAdmins(r, 'rolled_back', { restored });
    return this.get(a, r.id);
  }

  /**
   * After an approval: the open alerts this rule covers are classified again
   * now, not on their next report — each one audited and in its history.
   * Event alerts go through AlertQualityService.reclassifyOne (the classifier
   * with every rule in force); a threshold alert is resolved or capped.
   */
  private async applyToOpen(r: AlertQualityRule, now: Date) {
    const rows = await this.prisma.monitorAlert.findMany({
      where: { ruleKey: r.ruleKey, state: { not: 'RESOLVED' }, endpointId: { not: null }, kind: { not: 'SITE_OUTAGE' }, ...(r.customerId ? { customerId: r.customerId } : {}), ...(r.endpointId ? { endpointId: r.endpointId } : {}) },
      take: APPLY_LIMIT, orderBy: { lastSeenAt: 'desc' },
    });
    let changed = 0, closed = 0;
    for (const a of rows) {
      try {
        if (a.kind === 'EVENT_MATCH') {
          const before = a.severity;
          if (await this.aq.reclassifyOne(a, now, { id: r.id, name: r.name })) {
            const after = await this.prisma.monitorAlert.findUnique({ where: { id: a.id }, select: { state: true, severity: true } });
            if (after?.state === 'RESOLVED') closed++; else if (after && after.severity !== before) changed++;
          }
        } else if (await this.applyThreshold(a, r, now)) changed++;
      } catch (e) { this.logger.warn(`apply ${r.id} to ${a.id}: ${(e as Error).message}`); }
    }
    return { checked: rows.length, changed, closed };
  }

  private async applyThreshold(a: MonitorAlert, r: AlertQualityRule, now: Date) {
    const ep = await this.prisma.endpoint.findUnique({ where: { id: a.endpointId! }, select: { id: true, customerId: true, platform: true, osVersion: true } });
    if (!ep || !a.ruleId) return false;
    const monitor = await this.prisma.monitorRule.findUnique({ where: { id: a.ruleId }, select: { severity: true } });
    const t = await this.engine.forThreshold(ep, { key: a.ruleKey, id: a.ruleId }, (monitor?.severity ?? a.severity) as Sev, now, false);
    if (!t.ruleId || t.severity === a.severity) return false;
    const ev = { from: a.severity, to: t.severity, basis: 'quality_rule', qualityRules: [t.ruleId] };
    if (t.severity === null) {
      await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'reclassified', detail: ev as Prisma.InputJsonValue } });
      await this.audit.log({ action: 'MONITOR_ALERT_RECLASSIFIED', tenantId: a.tenantId ?? undefined, customerId: a.customerId ?? undefined, resource: 'monitor_alert', resourceId: a.id, meta: { monitor: a.ruleKey, endpointId: a.endpointId, ...ev, closed: true } });
      await this.mon.resolve(a, null, `Closed by an approved alert quality rule ("${r.name}"): this monitor's alerts are suppressed here.`, now);
      return true;
    }
    if (RANKS[t.severity] >= RANKS[a.severity as Sev]) return false;
    const u = await this.prisma.monitorAlert.updateMany({ where: { id: a.id, state: { not: 'RESOLVED' }, severity: a.severity }, data: { severity: t.severity } });
    if (!u.count) return false;
    await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'reclassified', detail: ev as Prisma.InputJsonValue } });
    await this.audit.log({ action: 'MONITOR_ALERT_RECLASSIFIED', tenantId: a.tenantId ?? undefined, customerId: a.customerId ?? undefined, resource: 'monitor_alert', resourceId: a.id, meta: { monitor: a.ruleKey, endpointId: a.endpointId, ...ev, closed: false } });
    await this.events.emit(a.id, 'alert.updated');
    return true;
  }

  // ── Expiry and review (the monitoring sweep) ──────────────────────────────

  async expiryPass(now = new Date()) {
    const due = await this.prisma.alertQualityRule.findMany({ where: { status: 'active', temporary: true, expiresAt: { lte: now } }, take: 200 });
    for (const r of due) {
      const u = await this.prisma.alertQualityRule.updateMany({ where: { id: r.id, status: 'active', temporary: true, expiresAt: { lte: now } }, data: { status: 'expired' } });
      if (!u.count) continue;
      let restored: string | null = null;
      if (r.supersedesId) {
        // An expired revision hands back to the version it replaced, if that one is still good.
        const prev = await this.prisma.alertQualityRule.findUnique({ where: { id: r.supersedesId }, select: { id: true, status: true, temporary: true, expiresAt: true } });
        if (prev && prev.status === 'superseded' && !(prev.temporary && prev.expiresAt && prev.expiresAt <= now)) {
          const v = await this.prisma.alertQualityRule.updateMany({ where: { id: prev.id, status: 'superseded' }, data: { status: 'active' } }).catch(() => ({ count: 0 }));
          if (v.count) { restored = prev.id; await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: prev.id, type: 'restored', revision: 0, detail: { after: r.id, reason: 'expired' } } }); }
        }
      }
      await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'expired', revision: r.revision, detail: { expiresAt: r.expiresAt, restored } } });
      await this.audit.log({ action: 'ALERT_QUALITY_RULE_EXPIRED', tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined, resource: 'alert_quality_rule', resourceId: r.id,
        meta: { scope: r.scopeKey, monitor: r.ruleKey, expiresAt: r.expiresAt, matchCount: r.matchCount, restored } });
      await this.notifyAdmins(r, 'expired', { restored });
    }
    if (due.length) this.engine.invalidate();
    const review = await this.prisma.alertQualityRule.findMany({ where: { status: 'active', temporary: false, reviewAt: { lte: now }, reviewNotifiedAt: null }, take: 200 });
    for (const r of review) {
      const u = await this.prisma.alertQualityRule.updateMany({ where: { id: r.id, reviewNotifiedAt: null }, data: { reviewNotifiedAt: now } });
      if (!u.count) continue;
      await this.prisma.alertQualityRuleEvent.create({ data: { ruleId: r.id, type: 'review_due', revision: r.revision, detail: { reviewAt: r.reviewAt } } });
      await this.notifyAdmins(r, 'review_due');
    }
    return { expired: due.length, reviewDue: review.length };
  }

  // ── Telling administrators ────────────────────────────────────────────────

  /**
   * Mail about a significant rule change, to confirmed recipients only: the
   * Platform Admins' (global list) and, for a business's rule, its Business
   * Owners' (that business's list). Ids and the rule's own name, never event
   * text. A `notifications` pause stops it. Never throws.
   */
  async notifyAdmins(r: Pick<AlertQualityRule, 'id' | 'name' | 'customerId' | 'scopeKey' | 'ruleKey' | 'behaviourKind' | 'risk' | 'expiresAt' | 'reviewAt'>, what: 'proposed_high_risk' | 'second_approval_needed' | 'approved' | 'rolled_back' | 'expired' | 'review_due', extra: Record<string, unknown> = {}) {
    try {
      if (await activePause(this.prisma, 'notifications', r.customerId)) return 0;
      const subject: Record<typeof what, string> = {
        proposed_high_risk: 'Rem0te: a high-risk alert rule was proposed',
        second_approval_needed: 'Rem0te: an alert rule needs a second approver',
        approved: 'Rem0te: an alert rule is now in force',
        rolled_back: 'Rem0te: an alert rule was rolled back',
        expired: 'Rem0te: a temporary alert rule expired',
        review_due: 'Rem0te: an alert rule is due for review',
      };
      const lines = [
        `Rule: ${r.name} (${r.id})`, `Monitor: ${r.ruleKey}`, `Scope: ${r.scopeKey}`, `What it does: ${r.behaviourKind}`, `Risk: ${r.risk}`,
        ...(what === 'expired' ? [`It stopped applying at ${r.expiresAt?.toISOString()}.${extra.restored ? ' The version it replaced applies again.' : ''}`] : []),
        ...(what === 'review_due' ? [`Its review date was ${r.reviewAt?.toISOString().slice(0, 10)}. It still applies until someone revises or rolls it back.`] : []),
        ...(what === 'approved' && extra.checked !== undefined ? [`Open alerts checked: ${extra.checked}; changed: ${extra.changed}; closed: ${extra.closed}.`] : []),
        '', 'Review it under Alerts → False Positives & Rule Improvements.',
      ];
      const admins = await this.prisma.user.findMany({ where: { isPlatformAdmin: true, status: 'ACTIVE' }, select: { email: true }, take: 100 });
      const owners = r.customerId ? await this.prisma.user.findMany({ where: { status: 'ACTIVE', memberships: { some: { customerId: r.customerId, isActive: true, role: { type: 'BUSINESS_OWNER' } } } }, select: { email: true }, take: 100 }) : [];
      const want = [
        ...admins.map((u) => ({ address: u.email.toLowerCase(), scopeKey: 'global' })),
        ...owners.map((u) => ({ address: u.email.toLowerCase(), scopeKey: `b:${r.customerId}` })),
      ];
      if (!want.length) return 0;
      const rows = await this.prisma.emailRecipient.findMany({
        where: { verifiedAt: { not: null }, OR: want.map((w) => ({ address: w.address, scopeKey: w.scopeKey })) },
        select: { id: true, scopeKey: true, address: true, customerId: true },
      });
      const seen = new Set<string>();
      let sent = 0;
      for (const row of rows) {
        if (seen.has(row.address)) continue;
        seen.add(row.address);
        const res = await this.email.sendToRecipients([row.id], row.scopeKey, { subject: subject[what], text: lines.join('\n') }, { customerId: row.customerId });
        if (res[0]?.ok) sent++;
      }
      return sent;
    } catch (e) {
      this.logger.warn(`notify (${what}) for ${r.id}: ${(e as Error).message}`);
      return 0;
    }
  }
}

const RANKS: Record<Sev, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
