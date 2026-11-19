import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, type MonitorAlert } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CLASSIFIER_VERSION, classifyEvents, KNOWN_BENIGN, samplesOf } from './classify';
import { DISK_ERRORS_PARAMS, DISK_ERRORS_PRE066_PARAMS, type Severity } from './engine';
import { MonitoringService } from './monitoring.service';
import { AlertEventsService } from './alert-events.service';

/** Open event alerts looked at per start. More are left for the next start (and are still correct, only older-classified). */
const RECLASSIFY_BATCH = 2000;

/**
 * Two one-shot corrections on API start (0.66), each idempotent, each a
 * conditional write, each audited. Two API processes starting at once do each
 * write once: the second's conditional update matches nothing.
 *
 *   1. The recommended disk-errors monitor. A stored rule with key
 *      `disk-errors` whose parameters are still exactly the pre-0.66
 *      recommended ones (DISK_ERRORS_PRE066_PARAMS) is given the 0.66 ones. A
 *      rule whose parameters a person changed is never touched: their
 *      parameters are no longer the recommended ones.
 *
 *   2. Open event alerts classified by an older classifier, or by none (an
 *      alert raised before 0.66), are classified again from the evidence they
 *      stored. The severity moves to the classifier's; an alert whose every
 *      counted event was a known-harmless pattern is resolved by the monitor
 *      with a note saying so. Each change is an alert history entry and an
 *      audit row. Nothing is deleted or hidden: the alert, its history and its
 *      raw events stay.
 */
@Injectable()
export class AlertQualityService implements OnApplicationBootstrap {
  private readonly logger = new Logger('AlertQuality');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mon: MonitoringService,
    private readonly events: AlertEventsService,
  ) {}

  async onApplicationBootstrap() {
    try { await this.correctDiskErrors(); } catch (e) { this.logger.warn(`disk-errors correction: ${(e as Error).message}`); }
    try { await this.reclassifyOpen(); } catch (e) { this.logger.warn(`reclassification: ${(e as Error).message}`); }
  }

  async correctDiskErrors() {
    const old = DISK_ERRORS_PRE066_PARAMS as unknown as Prisma.InputJsonValue;
    const rows = await this.prisma.monitorRule.findMany({ where: { key: 'disk-errors', kind: 'EVENT_MATCH', params: { equals: old } }, include: { customer: { select: { tenantId: true } } } });
    let changed = 0;
    for (const r of rows) {
      const u = await this.prisma.monitorRule.updateMany({ where: { id: r.id, key: 'disk-errors', kind: 'EVENT_MATCH', params: { equals: old } }, data: { params: DISK_ERRORS_PARAMS as unknown as Prisma.InputJsonValue } });
      if (!u.count) continue;
      changed++;
      await this.audit.log({
        action: 'MONITOR_RULE_CHANGED', tenantId: r.customer?.tenantId ?? undefined, customerId: r.customerId ?? undefined,
        resource: 'monitor_rule', resourceId: r.id,
        meta: { op: 'corrected', by: 'rem0te-0.66', reason: 'the recommended disk-errors monitor named no level, so informational events were critical disk alerts', scope: r.scopeKey, key: r.key, before: DISK_ERRORS_PRE066_PARAMS, after: DISK_ERRORS_PARAMS },
      });
    }
    if (changed) this.logger.log(`corrected ${changed} disk-errors monitor(s) to the 0.66 recommended parameters`);
    return changed;
  }

  async reclassifyOpen(now = new Date()) {
    const rows = await this.prisma.monitorAlert.findMany({
      where: { kind: 'EVENT_MATCH', state: { not: 'RESOLVED' }, OR: [{ classifierVersion: null }, { classifierVersion: { lt: CLASSIFIER_VERSION } }] },
      orderBy: { lastSeenAt: 'desc' }, take: RECLASSIFY_BATCH,
    });
    let moved = 0;
    for (const a of rows) {
      try { if (await this.reclassifyOne(a, now)) moved++; } catch (e) { this.logger.warn(`reclassify ${a.id}: ${(e as Error).message}`); }
    }
    return moved;
  }

  /** Returns true when the severity changed or the alert was closed. */
  async reclassifyOne(a: MonitorAlert, now: Date) {
    const rule = a.ruleId ? await this.prisma.monitorRule.findUnique({ where: { id: a.ruleId }, select: { severity: true, params: true } }) : null;
    const detail = (a.detail && typeof a.detail === 'object' ? a.detail : {}) as Record<string, unknown>;
    const samples = samplesOf(detail);
    const count = typeof detail.count === 'number' ? detail.count : samples.length;
    const ruleView = rule
      ? { severity: rule.severity as Severity, params: rule.params as Record<string, unknown> }
      : { severity: a.severity as Severity, params: { log: detail.log } };
    const cls = classifyEvents(ruleView, { count, samples });
    const stamp = { classification: cls as unknown as Prisma.InputJsonValue, classifierVersion: cls.v, fingerprint: cls.fingerprint };
    const from = a.severity as Severity;
    const to = cls.severity;
    const u = await this.prisma.monitorAlert.updateMany({
      where: { id: a.id, state: { not: 'RESOLVED' }, classifierVersion: a.classifierVersion },
      data: { ...stamp, ...(to ? { severity: to } : {}) },
    });
    if (!u.count) return false;
    if (to === from) return false;
    const benign = cls.matched ? KNOWN_BENIGN.find((b) => b.id === cls.matched) : undefined;
    const ev = { from, to: to ?? null, class: cls.class, basis: cls.basis, matched: cls.matched, classifierVersion: cls.v, seen: cls.seen, unseen: cls.unseen };
    await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'reclassified', detail: ev as Prisma.InputJsonValue } });
    await this.audit.log({
      action: 'MONITOR_ALERT_RECLASSIFIED', tenantId: a.tenantId ?? undefined, customerId: a.customerId ?? undefined,
      resource: 'monitor_alert', resourceId: a.id, meta: { monitor: a.ruleKey, endpointId: a.endpointId, ...ev, closed: to === null },
    });
    if (to === null) {
      await this.mon.resolve({ ...a, ...stamp } as MonitorAlert, null, `Closed by reclassification: every matching event was a known harmless pattern${benign ? ` (${benign.title})` : ''}.`, now);
    } else {
      await this.events.emit(a.id, 'alert.updated');
    }
    return true;
  }
}
