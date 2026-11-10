import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AlertEvent, AlertTicketLink, CONTRACT, type ALERT_EVENT_TYPES } from '../integration/contract';
import { loadTrust, type Peer } from '../integration/peers';
import { signAlertEvent } from '../integration/signer';
import { E, IntegrationError } from '../integration/errors';
import { patchSummaryFor } from '../patching/summary-db';
import { redactedPatchSummary } from '../patching/summary';

type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

const INCLUDE = {
  endpoint: { select: { name: true } },
  site: { select: { name: true } },
} as const;
type Row = Prisma.MonitorAlertGetPayload<{ include: typeof INCLUDE }>;

/** The contract's view of an alert. Only sanitised, rem0te-built fields. */
export function toContractAlert(a: Row, patchSummary: ReturnType<typeof redactedPatchSummary> | null = null) {
  return {
    alert_id: a.id,
    monitor: a.ruleKey.slice(0, 64),
    kind: a.kind as never,
    severity: a.severity.toLowerCase() as 'info' | 'warning' | 'critical',
    state: a.state.toLowerCase() as 'open' | 'acknowledged' | 'resolved',
    title: a.title.slice(0, 300),
    rem0te_endpoint_id: a.endpointId,
    computer_name: a.endpoint?.name?.slice(0, 128) ?? null,
    site_name: a.site?.name?.slice(0, 128) ?? null,
    first_seen_at: a.firstSeenAt.toISOString(),
    last_seen_at: a.lastSeenAt.toISOString(),
    occurrences: a.occurrences,
    resolved_at: a.resolvedAt?.toISOString() ?? null,
    outage_alert_id: a.parentId,
    ticket: a.ticketId ? { id: a.ticketId, url: a.ticketUrl } : null,
    patch_summary: patchSummary,
  };
}

/**
 * Monitoring → ClientSt0r (v0.29). Alert events are signed, sequenced per
 * (peer, organization) and stored; the integration worker pushes them to
 * the peer's events URL, and the peer can always recover by polling.
 *
 * The peer sees an alert only once an `alert.raised` was emitted to it,
 * which happens only when the business's notification policy turns
 * ticketing on and the alert meets its severity floor. Every later route
 * (poll, read, link a ticket) is scoped to alerts the peer was told about,
 * for organizations mapped to it now.
 */
@Injectable()
export class AlertEventsService {
  private readonly logger = new Logger('AlertEvents');
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * Append an event for every live organization mapping of the alert's
   * business. `alert.raised` is emitted once per peer; `updated` and
   * `resolved` only to peers that already had `raised`.
   */
  async emit(alertId: string, type: AlertEventType) {
    const trust = loadTrust();
    if (!trust) return 0;
    const a = await this.prisma.monitorAlert.findUnique({ where: { id: alertId }, include: INCLUDE });
    if (!a?.customerId) return 0;
    const maps = await this.prisma.integrationOrgMapping.findMany({ where: { customerId: a.customerId, revokedAt: null } });
    const patch = await this.patchFor(a);
    let n = 0;
    for (const m of maps) {
      if (!trust.peers.has(m.peerId)) continue;
      const had = await this.prisma.integrationAlertEvent.findFirst({ where: { alertId, peerId: m.peerId, externalOrgId: m.externalOrgId, type: 'alert.raised' }, select: { id: true } });
      if (type === 'alert.raised' ? had : !had) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          const seq = await tx.integrationOrgMapping.update({ where: { id: m.id }, data: { lastAlertSequence: { increment: 1 } }, select: { lastAlertSequence: true } });
          const ev: AlertEvent = {
            contract: CONTRACT, event_id: randomUUID(), sequence: seq.lastAlertSequence, type,
            occurred_at: new Date().toISOString(), peer_id: m.peerId, organization_id: m.externalOrgId, alert: toContractAlert(a, patch),
          };
          AlertEvent.parse(ev); // never sign something the contract would refuse
          const sig = signAlertEvent(ev);
          await tx.integrationAlertEvent.create({
            data: { id: ev.event_id, peerId: m.peerId, externalOrgId: m.externalOrgId, sequence: ev.sequence, alertId, type, body: ev as unknown as Prisma.InputJsonValue, signature: sig.sig, keyId: sig.kid },
          });
        });
        n++;
      } catch (e) {
        this.logger.warn(`alert event ${type} for ${alertId} → ${m.peerId}/${m.externalOrgId}: ${(e as Error).message}`);
      }
    }
    if (n) await this.prisma.monitorAlertEvent.create({ data: { alertId, type: 'ticket_event', detail: { event: type, organizations: n } } });
    return n;
  }

  /** The redacted patch summary a REBOOT_PENDING computer alert carries (contract revision 2). */
  private async patchFor(a: Row) {
    if (a.kind !== 'REBOOT_PENDING' || !a.endpointId) return null;
    return redactedPatchSummary(await patchSummaryFor(this.prisma, a.endpointId));
  }

  private async mapping(peer: Peer, org: string | undefined) {
    if (!org || !/^[A-Za-z0-9._:@-]{1,128}$/.test(org)) throw E.invalid('organization_id is required');
    const m = await this.prisma.integrationOrgMapping.findUnique({ where: { peerId_externalOrgId: { peerId: peer.id, externalOrgId: org } } });
    if (!m || m.revokedAt) throw E.forbidden('Organization is not mapped');
    return m;
  }

  /** An alert this peer was told about for this organization; NOT_FOUND otherwise. */
  private async scoped(peer: Peer, org: string, alertId: string) {
    const m = await this.mapping(peer, org);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(alertId)) throw new IntegrationError(404, 'NOT_FOUND', 'No such alert');
    const told = await this.prisma.integrationAlertEvent.findFirst({ where: { alertId, peerId: peer.id, externalOrgId: org }, select: { id: true } });
    const a = told ? await this.prisma.monitorAlert.findFirst({ where: { id: alertId, customerId: m.customerId }, include: INCLUDE }) : null;
    if (!a) throw new IntegrationError(404, 'NOT_FOUND', 'No such alert');
    return { m, a };
  }

  async poll(peer: Peer, org: string | undefined, after: number) {
    const m = await this.mapping(peer, org);
    const rows = await this.prisma.integrationAlertEvent.findMany({
      where: { peerId: peer.id, externalOrgId: m.externalOrgId, sequence: { gt: Math.max(0, after) } }, orderBy: { sequence: 'asc' }, take: 100,
    });
    return {
      organization_id: m.externalOrgId,
      last_sequence: m.lastAlertSequence,
      events: rows.map((r) => ({ alert_event: r.body, signature: { alg: 'Ed25519', kid: r.keyId, sig: r.signature } })),
    };
  }

  async get(peer: Peer, org: string | undefined, alertId: string) {
    const { a } = await this.scoped(peer, org ?? '', alertId);
    return toContractAlert(a, await this.patchFor(a));
  }

  /**
   * ClientSt0r says which ticket it opened. Idempotent for the same ticket;
   * a different ticket is a conflict — re-linking is a human decision made
   * in rem0te, not something a peer can overwrite.
   */
  async linkTicket(peer: Peer, alertId: string, raw: unknown) {
    const p = AlertTicketLink.safeParse(raw);
    if (!p.success) throw E.invalid(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300));
    const { a, m } = await this.scoped(peer, p.data.organization_id, alertId);
    if (a.ticketId) {
      if (a.ticketId === p.data.ticket_id && a.ticketPeerId === peer.id) return { replayed: true, alert: toContractAlert(a, await this.patchFor(a)) };
      throw new IntegrationError(409, 'TICKET_ALREADY_LINKED', 'This alert is already linked to a different ticket');
    }
    const r = await this.prisma.monitorAlert.updateMany({
      where: { id: a.id, ticketId: null },
      data: { ticketPeerId: peer.id, ticketId: p.data.ticket_id, ticketUrl: p.data.ticket_url, ticketLinkedAt: new Date() },
    });
    if (!r.count) throw new IntegrationError(409, 'TICKET_ALREADY_LINKED', 'This alert is already linked to a different ticket');
    await this.prisma.monitorAlertEvent.create({ data: { alertId: a.id, type: 'ticket_linked', detail: { peer: peer.id, organization: m.externalOrgId, ticketId: p.data.ticket_id } } });
    await this.audit.log({
      action: 'MONITOR_ALERT_TICKET_LINKED', tenantId: m.tenantId, customerId: m.customerId, resource: 'monitor_alert', resourceId: a.id,
      meta: { peer: peer.id, organization: m.externalOrgId, ticketId: p.data.ticket_id },
    });
    await this.emit(a.id, 'alert.updated');
    const fresh = await this.prisma.monitorAlert.findUnique({ where: { id: a.id }, include: INCLUDE });
    return { replayed: false, alert: toContractAlert(fresh!, await this.patchFor(fresh!)) };
  }
}
