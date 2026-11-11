import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type ReportSchedule } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { CAP, type Capability } from '../rbac/capabilities';
import { PublicUrlService } from '../platform/public-url.service';
import { EmailService } from '../email/email.service';
import { reportFailedMail, reportMail } from '../email/mail-content';
import { activePause } from '../containment/pause';
import { mayManageNotifications } from '../monitoring/notify-who';
import { PERIOD_DAYS, REPORT_KEYS, ReportsService, SILENT_DAYS, type ReportKey, type ReportQuery } from './reports.service';
import { CATCH_UP_MS, describeSpec, nextOccurrence, parseScheduleSpec, periodDaysFor, previousOccurrence, type ReportScheduleSpec } from './schedule';

/**
 * Scheduled reports (0.34): a report emailed weekly or monthly.
 *
 * Who: whoever decides who is notified for that scope — a Business Owner of
 * the business in their own right, or a Platform Admin (a platform-wide
 * schedule is a Platform Admin's alone, as a platform-wide report is). The
 * person who saves a schedule becomes its owner.
 *
 * Evaluated as the owner, at send time. The owner's access is rebuilt from
 * the database (ActorResolverService.contextFor — as an approved action or a
 * patch policy is), and the schedule fails CLOSED when they are suspended,
 * no longer an owner of that business, or lack the report's capability:
 * nothing of the report is sent, the recipients are told it was not sent
 * (and nothing else), the schedule is switched off, and it is audited as
 * REPORT_SCHEDULE_FAILED. A Business Owner whose computers changed sees the
 * changed list: the report is computed from their visibility now, not then.
 *
 * Recipients are confirmed EmailRecipients of the schedule's own scope,
 * checked when it is saved and again when it is sent.
 *
 * The CSV, when attached, is ReportsService.exportCsv — the same export a
 * person downloads, with the same row cap (refused above it, never
 * truncated) and the same REPORT_EXPORTED audit row, which names the
 * schedule. Without a CSV the mail carries only a link.
 *
 * Exactly once per period: a ReportDelivery row unique on (schedule, period)
 * is created BEFORE anything is sent. A second sweeper, a restart, or a
 * retry finds it and sends nothing. A crash between the claim and the send
 * leaves the period "sending" — it is not retried: a missed report is
 * recoverable by a person, a duplicate CSV in someone's mailbox is not.
 *
 * Bounded: at most SWEEP_BATCH schedules a pass, each to at most 10
 * recipients. REPORT_SCHEDULE_SWEEP=off stops the sweep in a process.
 * A `notifications` containment pause blocks the period (recorded, not sent).
 */

const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const SWEEP_BATCH = 20;
export const MAX_SCHEDULES_PER_SCOPE = 50;

export const REPORT_CAPABILITY: Record<ReportKey, Capability> = {
  'patch-compliance': CAP.COMPUTERS_VIEW, 'agent-coverage': CAP.COMPUTERS_VIEW,
  'alert-frequency': CAP.ALERTS_VIEW, 'offline-time': CAP.ALERTS_VIEW,
};

const ScheduleInput = z.object({
  report: z.enum(REPORT_KEYS),
  businessId: z.string().regex(ID).nullable().optional(),
  siteId: z.string().regex(ID).nullable().optional(),
  silentDays: z.number().int().refine((n) => (SILENT_DAYS as readonly number[]).includes(n)).optional(),
  frequency: z.enum(['weekly', 'monthly']),
  dayOfWeek: z.number().int().nullable().optional(),
  dayOfMonth: z.number().int().nullable().optional(),
  time: z.string(),
  timeZone: z.string(),
  attachCsv: z.boolean().default(false),
  recipientIds: z.array(z.string().regex(ID)).min(1).max(10),
  enabled: z.boolean().default(true),
}).strict();

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });

@Injectable()
export class ReportSchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReportSchedules');
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly urls: PublicUrlService,
    private readonly email: EmailService,
    private readonly reports: ReportsService,
  ) {}

  onModuleInit() {
    if (process.env.REPORT_SCHEDULE_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.REPORT_SCHEDULE_SWEEP_SECONDS) || 60) * 1000;
    this.timer = setInterval(() => { void this.sweep(); }, every);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ── Who ───────────────────────────────────────────────────────────────────

  /** May this person own a schedule for this scope? Platform-wide: Platform Admin only. */
  private mayOwn(a: ActorContext, customerId: string | null) {
    if (!customerId) return a.isPlatformAdmin;
    // A technicians:manage holder who is not a Platform Admin cannot run a report outside a business they act in.
    return a.isPlatformAdmin || (mayManageNotifications(a, customerId, this.acl.isBusinessOwner(a)) && a.businessId === customerId);
  }

  private async scopeFor(a: ActorContext, businessId: string | null | undefined) {
    const id = businessId ?? (a.isPlatformAdmin ? null : a.businessId);
    if (!id) {
      if (!a.isPlatformAdmin) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Scheduled reports are set up by a Business Owner, or by a Platform Admin.' });
      return { customerId: null as string | null, scopeKey: 'global', tenantId: a.tenantId, name: null as string | null };
    }
    const c = await this.prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, tenantId: true } });
    if (!c || (!a.isPlatformAdmin && a.businessId !== c.id)) throw new NotFoundException('Business not found');
    if (!this.mayOwn(a, c.id)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Scheduled reports are set up by a Business Owner of this business, or by a Platform Admin.' });
    return { customerId: c.id as string | null, scopeKey: `b:${c.id}`, tenantId: c.tenantId as string | null, name: c.name as string | null };
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  private spec(s: Pick<ReportSchedule, 'frequency' | 'dayOfWeek' | 'dayOfMonth' | 'time' | 'timeZone'>): ReportScheduleSpec {
    return parseScheduleSpec({ frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, time: s.time, timeZone: s.timeZone });
  }

  private query(s: Pick<ReportSchedule, 'customerId' | 'siteId' | 'params' | 'frequency'>): ReportQuery {
    const p = (s.params ?? {}) as { silentDays?: number };
    return { businessId: s.customerId ?? undefined, siteId: s.siteId ?? undefined, days: periodDaysFor(s.frequency as 'weekly'), silentDays: (SILENT_DAYS as readonly number[]).includes(p.silentDays ?? 7) ? p.silentDays ?? 7 : 7 };
  }

  private async view(s: ReportSchedule & { deliveries?: { periodKey: string; status: string; occurrenceAt: Date; finishedAt: Date | null; rows: number | null; detail: Prisma.JsonValue }[] }) {
    const book = await this.email.addresses(s.recipientIds, s.customerId ? `b:${s.customerId}` : 'global');
    let describe: string | null = null;
    try { describe = describeSpec(this.spec(s)); } catch { /* stored before a rule tightened: shown as is */ }
    return {
      id: s.id, report: s.report, businessId: s.customerId, siteId: s.siteId, params: s.params,
      frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, time: s.time, timeZone: s.timeZone, describe,
      periodDays: periodDaysFor(s.frequency as 'weekly'),
      attachCsv: s.attachCsv, enabled: s.enabled, disabledReason: s.disabledReason, nextRunAt: s.enabled ? s.nextRunAt : null,
      ownerId: s.ownerId, createdAt: s.createdAt, updatedAt: s.updatedAt,
      recipients: s.recipientIds.map((id) => { const r = book.get(id); return { id, address: r?.address ?? null, label: r?.label ?? null, confirmed: !!r?.verifiedAt }; }),
      deliveries: (s.deliveries ?? []).map((d) => ({ period: d.periodKey, status: d.status, dueAt: d.occurrenceAt, finishedAt: d.finishedAt, rows: d.rows, detail: d.detail })),
    };
  }

  async list(a: ActorContext, businessId?: string | null) {
    let where: Prisma.ReportScheduleWhereInput;
    if (a.isPlatformAdmin) where = businessId ? { customerId: businessId } : {};
    else {
      const s = await this.scopeFor(a, businessId ?? a.businessId);
      where = { customerId: s.customerId };
    }
    const rows = await this.prisma.reportSchedule.findMany({
      where, orderBy: [{ createdAt: 'asc' }], take: 200,
      include: { deliveries: { orderBy: { occurrenceAt: 'desc' }, take: 5, select: { periodKey: true, status: true, occurrenceAt: true, finishedAt: true, rows: true, detail: true } } },
    });
    const scopeKey = businessId ? `b:${businessId}` : (a.isPlatformAdmin ? 'global' : `b:${a.businessId}`);
    let mayCreate = false;
    try { await this.scopeFor(a, businessId ?? null); mayCreate = true; } catch { /* read-only */ }
    return {
      schedules: await Promise.all(rows.map((r) => this.view(r))),
      recipients: mayCreate ? (await this.email.confirmedIn(scopeKey)).map((r) => ({ id: r.id, address: r.address, label: r.label })) : [],
      email: await this.email.status(),
      may: { create: mayCreate },
      periods: { weekly: periodDaysFor('weekly'), monthly: periodDaysFor('monthly') }, silentDays: SILENT_DAYS, periodDays: PERIOD_DAYS,
    };
  }

  private async scheduleFor(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException('Schedule not found');
    const s = await this.prisma.reportSchedule.findUnique({ where: { id } });
    if (!s || (!a.isPlatformAdmin && s.customerId !== a.businessId)) throw new NotFoundException('Schedule not found');
    if (!this.mayOwn(a, s.customerId)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Scheduled reports are changed by a Business Owner of this business, or by a Platform Admin.' });
    return s;
  }

  // ── Changes (the controller checks fresh authentication) ──────────────────

  private async validate(a: ActorContext, raw: unknown, base?: ReportSchedule) {
    const merged = base
      ? { report: base.report, businessId: base.customerId, siteId: base.siteId, frequency: base.frequency, dayOfWeek: base.dayOfWeek, dayOfMonth: base.dayOfMonth, time: base.time, timeZone: base.timeZone, attachCsv: base.attachCsv, recipientIds: base.recipientIds, enabled: base.enabled, ...((base.params as { silentDays?: number }).silentDays ? { silentDays: (base.params as { silentDays: number }).silentDays } : {}), ...(raw as object ?? {}) }
      : raw;
    const d = ScheduleInput.safeParse(merged ?? {});
    if (!d.success) throw bad(d.error);
    if (base && (d.data.businessId ?? null) !== base.customerId) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A schedule cannot move to another business. Create a new one there.' });
    }
    let spec: ReportScheduleSpec;
    try { spec = parseScheduleSpec(d.data); } catch (e) { throw new BadRequestException({ code: 'INVALID_SCHEDULE', message: (e as Error).message }); }
    const s = await this.scopeFor(a, d.data.businessId ?? null);
    // The owner must be able to see the report now; a report they cannot run is refused here, not at 3 a.m.
    this.acl.assertCapability(a, REPORT_CAPABILITY[d.data.report]);
    if (d.data.siteId) {
      const site = await this.prisma.site.findUnique({ where: { id: d.data.siteId }, select: { customerId: true } });
      if (!site || !s.customerId || site.customerId !== s.customerId) throw new NotFoundException('Site not found');
    }
    const recipientIds = await this.email.assertConfirmed(d.data.recipientIds, s.scopeKey);
    if (base === undefined && (await this.prisma.reportSchedule.count({ where: { customerId: s.customerId } })) >= MAX_SCHEDULES_PER_SCOPE) {
      throw new BadRequestException({ code: 'TOO_MANY', message: `At most ${MAX_SCHEDULES_PER_SCOPE} scheduled reports per business.` });
    }
    return { d: d.data, spec, s, recipientIds };
  }

  async create(a: ActorContext, raw: unknown) {
    const { d, spec, s, recipientIds } = await this.validate(a, raw);
    const now = new Date();
    const row = await this.prisma.reportSchedule.create({
      data: {
        tenantId: s.tenantId, customerId: s.customerId, siteId: d.siteId ?? null, report: d.report,
        params: d.report === 'agent-coverage' && d.silentDays ? { silentDays: d.silentDays } : {},
        frequency: spec.frequency, dayOfWeek: spec.dayOfWeek, dayOfMonth: spec.dayOfMonth, time: spec.time, timeZone: spec.timeZone,
        attachCsv: d.attachCsv, recipientIds, ownerId: a.userId, enabled: d.enabled, nextRunAt: nextOccurrence(spec, now).at,
      },
    });
    await this.audit.log({ action: 'REPORT_SCHEDULE_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, resource: 'report_schedule', resourceId: row.id, meta: { op: 'create', ...this.auditShape(row) } });
    return this.view(row);
  }

  async update(a: ActorContext, id: string, raw: unknown) {
    const base = await this.scheduleFor(a, id);
    const { d, spec, s, recipientIds } = await this.validate(a, raw, base);
    const row = await this.prisma.reportSchedule.update({
      where: { id },
      data: {
        siteId: d.siteId ?? null, report: d.report, params: d.report === 'agent-coverage' && d.silentDays ? { silentDays: d.silentDays } : {},
        frequency: spec.frequency, dayOfWeek: spec.dayOfWeek, dayOfMonth: spec.dayOfMonth, time: spec.time, timeZone: spec.timeZone,
        attachCsv: d.attachCsv, recipientIds, enabled: d.enabled, disabledReason: d.enabled ? null : base.disabledReason,
        // Whoever saves it now answers for what it sends.
        ownerId: a.userId, nextRunAt: nextOccurrence(spec, new Date()).at,
      },
    });
    await this.audit.log({ action: 'REPORT_SCHEDULE_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, resource: 'report_schedule', resourceId: id, meta: { op: 'update', before: this.auditShape(base), after: this.auditShape(row) } });
    return this.view(row);
  }

  async remove(a: ActorContext, id: string) {
    const s = await this.scheduleFor(a, id);
    await this.prisma.reportSchedule.delete({ where: { id } });
    await this.audit.log({ action: 'REPORT_SCHEDULE_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, resource: 'report_schedule', resourceId: id, meta: { op: 'delete', ...this.auditShape(s) } });
    return { deleted: true };
  }

  private auditShape(s: ReportSchedule) {
    return { report: s.report, businessId: s.customerId, siteId: s.siteId, frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, time: s.time, timeZone: s.timeZone, attachCsv: s.attachCsv, recipientIds: s.recipientIds, enabled: s.enabled, ownerId: s.ownerId };
  }

  // ── The sweep ─────────────────────────────────────────────────────────────

  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.prisma.reportSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: SWEEP_BATCH });
      for (const s of due) {
        try { await this.runOne(s, now); } catch (e) { this.log.warn(`schedule ${s.id}: ${(e as Error).message}`); }
      }
    } catch (e) {
      this.log.error(`report schedule sweep: ${(e as Error).message}`);
    } finally { this.busy = false; }
  }

  private async runOne(s: ReportSchedule, now: Date) {
    let spec: ReportScheduleSpec;
    try { spec = this.spec(s); } catch {
      await this.prisma.reportSchedule.update({ where: { id: s.id }, data: { enabled: false, disabledReason: 'The stored schedule is not valid.' } });
      return;
    }
    const occ = previousOccurrence(spec, now);
    // Move the schedule on first: a failure below must not make the sweep pick it up again every minute.
    await this.prisma.reportSchedule.update({ where: { id: s.id }, data: { nextRunAt: nextOccurrence(spec, now).at } });
    if (occ.at < s.createdAt) return; // fell due before the schedule existed
    const late = now.getTime() - occ.at.getTime() > CATCH_UP_MS;
    // The claim. Unique on (schedule, period): whoever creates it sends; nobody else does, ever.
    try {
      await this.prisma.reportDelivery.create({ data: { scheduleId: s.id, periodKey: occ.periodKey, occurrenceAt: occ.at, status: late ? 'missed' : 'sending', ...(late ? { finishedAt: now, detail: { reason: 'The server was not running a sweep within a day of when this was due.' } } : {}) } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return;
      throw e;
    }
    if (late) return;
    await this.deliver(s, spec, occ.periodKey, now);
  }

  private async finish(scheduleId: string, periodKey: string, status: string, detail: Record<string, unknown>, rows: number | null = null) {
    await this.prisma.reportDelivery.update({ where: { scheduleId_periodKey: { scheduleId, periodKey } }, data: { status, detail: detail as Prisma.InputJsonValue, rows, finishedAt: new Date() } });
  }

  private async deliver(s: ReportSchedule, spec: ReportScheduleSpec, periodKey: string, now: Date) {
    const scopeKey = s.customerId ? `b:${s.customerId}` : 'global';
    const report = s.report as ReportKey;
    const [biz, site] = await Promise.all([
      s.customerId ? this.prisma.customer.findUnique({ where: { id: s.customerId }, select: { name: true } }) : null,
      s.siteId ? this.prisma.site.findUnique({ where: { id: s.siteId }, select: { name: true } }) : null,
    ]);
    const label = { report, business: biz?.name ?? null, schedule: describeSpec(spec) };
    const auditBase = { tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined, resource: 'report_schedule', resourceId: s.id };

    const pause = await activePause(this.prisma, 'notifications', s.customerId);
    if (pause) {
      await this.finish(s.id, periodKey, 'blocked', { reason: 'contained', pauseId: pause.id });
      await this.audit.log({ ...auditBase, action: 'REPORT_SCHEDULE_FAILED', actorId: s.ownerId, meta: { period: periodKey, reason: 'contained', pauseId: pause.id } });
      return;
    }

    // The owner, now — from the database, not from when they saved it.
    const actor = await this.actors.contextFor(s.ownerId, s.tenantId ?? '', s.customerId);
    const refusal = this.ownerRefusal(actor, s);
    if (refusal) {
      // Fail closed: nothing of the report; the recipients learn only that it did not come.
      const told = await this.email.sendToRecipients(s.recipientIds, scopeKey, reportFailedMail(label, 'The person who set up this schedule no longer has access to this report.'), { customerId: s.customerId });
      await this.prisma.reportSchedule.update({ where: { id: s.id }, data: { enabled: false, disabledReason: `Switched off: ${refusal}` } });
      await this.finish(s.id, periodKey, 'failed', { reason: 'owner_lost_access', why: refusal, told: told.map((t) => ({ to: t.to, status: t.status })) });
      await this.audit.log({ ...auditBase, action: 'REPORT_SCHEDULE_FAILED', actorId: s.ownerId, meta: { period: periodKey, reason: 'owner_lost_access', why: refusal, disabled: true } });
      return;
    }

    const confirmed = await this.prisma.emailRecipient.count({ where: { id: { in: s.recipientIds }, scopeKey, verifiedAt: { not: null } } });
    if (!confirmed) {
      await this.finish(s.id, periodKey, 'failed', { reason: 'no_confirmed_recipients' });
      await this.audit.log({ ...auditBase, action: 'REPORT_SCHEDULE_FAILED', actorId: s.ownerId, meta: { period: periodKey, reason: 'no_confirmed_recipients' } });
      return;
    }

    const q = this.query(s);
    let attachment: { filename: string; content: string; contentType: string } | undefined;
    let rows: number | null = null;
    if (s.attachCsv) {
      try {
        const out = await this.reports.exportCsv(actor!, report, q, { scheduleId: s.id, recipients: confirmed });
        attachment = { filename: out.filename, content: out.csv, contentType: 'text/csv; charset=utf-8' };
        rows = out.rows;
      } catch (e) {
        const msg = e instanceof HttpException ? ((e.getResponse() as { message?: string }).message ?? e.message) : 'The report could not be produced.';
        const code = e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : 'ERROR';
        const told = await this.email.sendToRecipients(s.recipientIds, scopeKey, reportFailedMail(label, String(msg)), { customerId: s.customerId });
        await this.finish(s.id, periodKey, 'failed', { reason: code, told: told.map((t) => ({ to: t.to, status: t.status })) });
        await this.audit.log({ ...auditBase, action: 'REPORT_SCHEDULE_FAILED', actorId: s.ownerId, meta: { period: periodKey, reason: code } });
        return;
      }
    }

    const params = new URLSearchParams({ ...(s.customerId ? { businessId: s.customerId } : {}), ...(s.siteId ? { siteId: s.siteId } : {}), ...(report === 'alert-frequency' || report === 'offline-time' ? { days: String(q.days) } : {}), ...(report === 'agent-coverage' ? { silentDays: String(q.silentDays) } : {}) });
    const qs = params.toString();
    const link = `${this.urls.web()}/reports/${report}${qs ? `?${qs}` : ''}`;
    const mail = reportMail({ ...label, site: site?.name ?? null, days: report === 'alert-frequency' || report === 'offline-time' ? q.days : null, generatedAt: now, rows, attached: !!attachment }, link);
    const results = await this.email.sendToRecipients(s.recipientIds, scopeKey, mail, { customerId: s.customerId, attachments: attachment ? [attachment] : [] });
    const ok = results.filter((r) => r.ok).length;
    const status = ok === 0 ? 'failed' : ok === results.length ? 'sent' : 'partial';
    await this.finish(s.id, periodKey, status, { results: results.map((r) => ({ to: r.to, status: r.status })) }, rows);
    await this.audit.log({ ...auditBase, action: ok ? 'REPORT_SCHEDULE_SENT' : 'REPORT_SCHEDULE_FAILED', actorId: s.ownerId, meta: { period: periodKey, report, rows, attached: !!attachment, sent: ok, of: results.length, recipients: results.map((r) => r.recipientId) } });
  }

  /** Why the owner may no longer send this, or null. */
  private ownerRefusal(actor: ActorContext | null, s: ReportSchedule): string | null {
    if (!actor) return 'the owner\'s account is not active';
    if (!this.mayOwn(actor, s.customerId)) return s.customerId ? 'the owner is no longer a Business Owner of this business' : 'the owner is no longer a Platform Admin';
    if (!actor.isPlatformAdmin && !actor.capabilities.includes(REPORT_CAPABILITY[s.report as ReportKey])) return `the owner no longer has ${REPORT_CAPABILITY[s.report as ReportKey]}`;
    try { this.acl.resolveScope(actor, s.customerId); } catch { return 'the owner can no longer reach this business'; }
    return null;
  }
}
