import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PsaService } from '../psa/psa.service';
import { activePause } from '../containment/pause';
import { AUTO_TICKET, autoTicketDecision, ticketPolicyFor, type Severity, type TicketPolicyLike } from './engine';

const ALERT_SELECT = {
  id: true, kind: true, ruleKey: true, severity: true, state: true, title: true, firstSeenAt: true, notifyFrom: true,
  tenantId: true, customerId: true, siteId: true, endpointId: true, fingerprint: true,
  endpoint: { select: { id: true, name: true } },
  customer: { select: { name: true } },
  parent: { select: { state: true } },
} as const;

/**
 * Automatic PSA tickets from alerts (0.55).
 *
 * A rule — MonitorTicketPolicy, global or per business, a business's own row
 * replacing the global one — says "create a ticket in the PSA when an alert
 * of at least this severity (optionally only these kinds) opens". This pass
 * runs only inside the monitoring sweep (MonitoringService.sweep, after the
 * notification pass), so MONITOR_SWEEP=off stops it.
 *
 * For each open alert first seen since its rule was switched on, in order:
 * the rule (autoTicketDecision — severity, kinds, the notify hold, no open
 * site outage over it, no maintenance window), then the `notifications`
 * containment pause, then the per-business hourly budget, then
 * PsaService.alertTicket: the connector, the claim (MonitorAlertTicket,
 * unique per alert), PSA_AUTO_TICKET_REQUESTED written before the send, and
 * the send. A failed send is retried with backoff (AUTO_TICKET.backoffMinutes)
 * up to AUTO_TICKET.maxAttempts sends, then given up. Nothing here sends.
 *
 * 0.67: alert quality rules act before this (at ingest, and on the open
 * alerts when a rule is approved), so a suppressed alert is never raised and
 * a downgraded one is judged at its new severity. And one event signature on
 * one computer gets one ticket a day: an event alert whose computer, monitor
 * and fingerprint already had a ticket sent in the last 24 hours is linked to
 * that ticket (`duplicate`) instead of sending another.
 */
@Injectable()
export class AlertTicketsService {
  private readonly logger = new Logger('AlertTickets');

  constructor(private readonly prisma: PrismaService, private readonly psa: PsaService) {}

  private perHour() {
    const n = Number(process.env.PSA_AUTO_TICKETS_PER_HOUR);
    return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : AUTO_TICKET.perBusinessPerHour;
  }

  async pass(now = new Date()) {
    // A send interrupted mid-way (a restart) is given up, never resent: the
    // PSA may have made the ticket, and one ticket per alert is the rule.
    await this.prisma.monitorAlertTicket.updateMany({
      where: { status: 'sending', lastAttemptAt: { lt: new Date(now.getTime() - AUTO_TICKET.stuckMs) } },
      data: { status: 'gave_up', lastStatus: 'interrupted', nextAttemptAt: null },
    });
    const rows = await this.prisma.monitorTicketPolicy.findMany();
    const policies: TicketPolicyLike[] = rows.map((p) => ({ scopeKey: p.scopeKey, enabled: p.enabled, minSeverity: p.minSeverity as Severity, kinds: p.kinds, enabledAt: p.enabledAt }));
    const on = policies.filter((p) => p.enabled && p.enabledAt);
    if (!on.length) return { attempted: 0 };
    const earliest = new Date(Math.min(...on.map((p) => p.enabledAt!.getTime())));
    const sups = await this.prisma.monitorSuppression.findMany({ where: { revokedAt: null, endsAt: { gt: now }, startsAt: { lte: now } } });

    const fresh = await this.prisma.monitorAlert.findMany({
      where: { state: { not: 'RESOLVED' }, endpointId: { not: null }, kind: { not: 'SITE_OUTAGE' }, notifyFrom: { lte: now }, firstSeenAt: { gte: earliest }, autoTicket: { is: null } },
      orderBy: { firstSeenAt: 'asc' }, take: AUTO_TICKET.batch, select: ALERT_SELECT,
    });
    const retries = await this.prisma.monitorAlertTicket.findMany({
      where: { status: 'failed', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: AUTO_TICKET.batch,
      select: { id: true, attempts: true, alert: { select: ALERT_SELECT } },
    });
    const work = [...retries.map((r) => ({ a: r.alert, prior: { id: r.id, attempts: r.attempts } })), ...fresh.map((a) => ({ a, prior: null }))];

    const used = new Map<string, number>();
    let attempted = 0;
    for (const { a, prior } of work) {
      try {
        if (!a.endpoint) continue;
        const d = autoTicketDecision({ ...a, severity: a.severity as Severity, parentOpen: !!a.parent && a.parent.state !== 'RESOLVED' }, ticketPolicyFor(policies, a.customerId), sups, now);
        if (!d.ok) {
          // A retry whose alert is gone, or whose rule no longer asks for it, stops here.
          if (prior && ['resolved', 'off', 'no_rule', 'severity', 'kind'].includes(d.reason)) {
            await this.prisma.monitorAlertTicket.updateMany({ where: { id: prior.id, status: 'failed' }, data: { status: 'gave_up', lastStatus: `stopped_${d.reason}`, nextAttemptAt: null } });
          }
          continue;
        }
        // A `notifications` pause stops every outbound ticket, as it stops "Create ticket".
        if (await activePause(this.prisma, 'notifications', a.customerId)) continue;
        const bkey = a.customerId ?? '-';
        const n = used.get(bkey) ?? await this.prisma.monitorAlertTicket.count({ where: { customerId: a.customerId, lastAttemptAt: { gte: new Date(now.getTime() - 3_600_000) } } });
        used.set(bkey, n);
        if (n >= this.perHour()) continue;
        if (!prior && a.fingerprint && a.kind === 'EVENT_MATCH' && await this.linkDuplicate(a, now)) continue;
        const r = await this.psa.alertTicket({ ...a, endpoint: a.endpoint }, prior, now);
        if (r.attempted) { attempted++; used.set(bkey, n + 1); }
      } catch (e) {
        this.logger.warn(`auto ticket ${a.id}: ${(e as Error).message}`);
      }
    }
    return { attempted };
  }

  /** The same event on the same computer already has a ticket from the last day: link this alert to it, send nothing. */
  private async linkDuplicate(a: { id: string; customerId: string | null; endpointId: string | null; ruleKey: string; fingerprint: string | null }, now: Date) {
    const prev = await this.prisma.monitorAlertTicket.findFirst({
      where: { status: 'sent', lastAttemptAt: { gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) }, alert: { endpointId: a.endpointId, ruleKey: a.ruleKey, fingerprint: a.fingerprint, id: { not: a.id } } },
      orderBy: { lastAttemptAt: 'desc' }, select: { psaTicketId: true, ref: true, url: true, connectorKind: true, connectorScope: true },
    });
    if (!prev) return false;
    try {
      await this.prisma.monitorAlertTicket.create({ data: { alertId: a.id, customerId: a.customerId, status: 'gave_up', attempts: 1, lastAttemptAt: now, lastStatus: 'duplicate', ...prev } });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e; // another sweeper got it first
    }
    return true;
  }
}

/** One ticket per event signature per computer per day. */
const DUPLICATE_WINDOW_MS = 24 * 3_600_000;
