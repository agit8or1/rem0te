import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { validatePeerUrl } from '../integration/peers';

/**
 * Independent alerts. A security alert is always RECORDED (SecurityAlert +
 * audit) and, unless a suppression covers it, delivered to every configured
 * destination. Suppression silences delivery only: it never lifts a pause,
 * and the pause that caused the alert is raised whether or not anyone hears.
 *
 * Destinations are webhooks configured in the access policy. Changing them is
 * a trust change (independent review), so a stolen session cannot point the
 * alarm at itself.
 */
@Injectable()
export class SecurityAlertService {
  private readonly logger = new Logger('SecurityAlerts');
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async raise(p: {
    kind: string; identity?: string | null; customerId?: string | null; details: Record<string, unknown>;
    destinations: { url: string; label: string }[];
  }) {
    const now = new Date();
    const suppression = await this.prisma.alertSuppression.findFirst({
      where: {
        kind: { in: [p.kind, '*'] }, revokedAt: null, until: { gt: now },
        OR: [{ identity: null }, { identity: p.identity ?? undefined }],
      },
    });
    const alert = await this.prisma.securityAlert.create({
      data: {
        kind: p.kind, identity: p.identity ?? null, customerId: p.customerId ?? null,
        details: p.details as Prisma.InputJsonValue, suppressed: !!suppression,
      },
    });
    await this.audit.log({
      action: 'SECURITY_ALERT_RAISED', customerId: p.customerId ?? undefined, resource: 'security_alert', resourceId: alert.id,
      meta: { kind: p.kind, identity: p.identity, suppressed: !!suppression, destinations: p.destinations.length },
    });
    if (suppression || p.destinations.length === 0) return alert;

    const errors: string[] = [];
    for (const d of p.destinations) {
      try {
        const url = validatePeerUrl(d.url, 'alert destination');
        const r = await fetch(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'rem0te', alert_id: alert.id, kind: p.kind, identity: p.identity, customer_id: p.customerId, details: p.details, at: alert.createdAt.toISOString() }),
        });
        if (!r.ok) errors.push(`${d.label}: HTTP ${r.status}`);
      } catch (e) {
        errors.push(`${d.label}: ${(e as Error).name}`);
      }
    }
    await this.prisma.securityAlert.update({
      where: { id: alert.id },
      data: { delivered: errors.length < p.destinations.length, deliveryError: errors.length ? errors.join('; ').slice(0, 500) : null },
    });
    if (errors.length) this.logger.warn(`alert ${alert.id} delivery: ${errors.join('; ')}`);
    return alert;
  }
}
