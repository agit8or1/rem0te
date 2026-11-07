import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { TechnicianAccessService, computerAccessActive } from '../rbac/technician-access.service';
import { CAP, effectiveCapabilities, isOwnerRole } from '../rbac/capabilities';
import { describeSchedule, parseSchedule } from '../rbac/schedule';

export interface AccessEntry {
  userId: string;
  name: string;
  email: string;
  /** How this person reaches the computer. */
  via: 'PLATFORM_ADMIN' | 'BUSINESS_OWNER' | 'COMPUTER_GRANT' | 'COMPANY_WIDE' | 'TECHNICIAN_DIRECT' | 'TECHNICIAN_GROUP';
  detail: string;
  /** Right now, could they start a connection? */
  activeNow: boolean;
  inactiveReason?: string;
  startsAt?: string | null;
  expiresAt?: string | null;
  schedule?: string | null;
  temporary: boolean;
}

/**
 * Who can reach one computer, and why — the per-computer access review.
 *
 * Computed from the same rules the connect path enforces
 * (`AccessControlService.canReachEndpoint`), so the list cannot drift from
 * what actually happens: every entry's `activeNow` is that decision.
 */
@Injectable()
export class AccessReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly techAccess: TechnicianAccessService,
  ) {}

  async review(actor: ActorContext, endpointId: string) {
    const ep = await this.acl.assertEndpointInScope(actor, endpointId);
    // The review lists people, so it needs the people capability too.
    this.acl.assertCapability(actor, CAP.USERS_VIEW);
    const now = new Date();
    const endpoint = await this.prisma.endpoint.findUniqueOrThrow({
      where: { id: endpointId }, select: { id: true, name: true, customerId: true, accessMode: true },
    });
    const name = (u: { firstName: string | null; lastName: string | null; email: string }) =>
      [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
    const entries: AccessEntry[] = [];
    const push = (e: AccessEntry) => { entries.push(e); };

    const admins = await this.prisma.user.findMany({
      where: { isPlatformAdmin: true, status: 'ACTIVE' }, select: { id: true, firstName: true, lastName: true, email: true },
    });
    for (const u of admins) {
      push({ userId: u.id, name: name(u), email: u.email, via: 'PLATFORM_ADMIN', detail: 'Platform Admin — every computer on this server', activeNow: true, temporary: false });
    }

    const members = await this.prisma.membership.findMany({
      where: { customerId: endpoint.customerId ?? '__none__' },
      select: {
        isActive: true, capabilities: true, role: { select: { type: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true, status: true, isPlatformAdmin: true } },
      },
    });
    const grants = await this.prisma.computerAccess.findMany({
      where: { endpointId }, select: { userId: true, startsAt: true, expiresAt: true, schedule: true, createdAt: true },
    });
    const grantBy = new Map(grants.map((g) => [g.userId, g]));

    for (const m of members) {
      if (m.user.isPlatformAdmin) continue;
      const accountOk = m.isActive && m.user.status === 'ACTIVE';
      const caps = effectiveCapabilities({ roleType: m.role.type, capabilities: m.capabilities });
      const canConnect = caps.includes(CAP.COMPUTERS_CONNECT);
      if (isOwnerRole(m.role.type)) {
        push({
          userId: m.user.id, name: name(m.user), email: m.user.email, via: 'BUSINESS_OWNER',
          detail: 'Business Owner — every computer in this business', activeNow: accountOk,
          inactiveReason: accountOk ? undefined : 'account or membership disabled', temporary: false,
        });
        continue;
      }
      const g = grantBy.get(m.user.id);
      if (g) {
        const windowOk = computerAccessActive(g, now);
        let sched: string | null;
        try { sched = describeSchedule(parseSchedule(g.schedule)); } catch { sched = 'invalid schedule (denies access)'; }
        const reason = !accountOk ? 'account or membership disabled' : !canConnect ? 'no "connect" permission'
          : !windowOk ? (g.startsAt && g.startsAt > now ? 'not started yet' : g.expiresAt && g.expiresAt <= now ? 'expired' : 'outside its schedule') : undefined;
        push({
          userId: m.user.id, name: name(m.user), email: m.user.email, via: 'COMPUTER_GRANT',
          detail: 'Granted access to this computer', activeNow: !reason, inactiveReason: reason,
          startsAt: g.startsAt?.toISOString() ?? null, expiresAt: g.expiresAt?.toISOString() ?? null,
          schedule: sched, temporary: !!g.expiresAt,
        });
      }
      if (endpoint.accessMode === 'COMPANY_WIDE' && canConnect && !g) {
        push({
          userId: m.user.id, name: name(m.user), email: m.user.email, via: 'COMPANY_WIDE',
          detail: 'Computer is company-wide; everyone in the business with "connect" can reach it',
          activeNow: accountOk, inactiveReason: accountOk ? undefined : 'account or membership disabled', temporary: false,
        });
      }
    }

    // Technicians: everyone with any assignment into this business.
    const assigned = await this.prisma.technicianAssignment.findMany({
      where: { customerId: endpoint.customerId ?? '__none__', revokedAt: null },
      select: { userId: true, group: { select: { members: { select: { userId: true } } } } },
    });
    const techIds = new Set<string>();
    for (const a of assigned) {
      if (a.userId) techIds.add(a.userId);
      for (const gm of a.group?.members ?? []) techIds.add(gm.userId);
    }
    const techUsers = await this.prisma.user.findMany({
      where: { id: { in: [...techIds] } }, select: { id: true, firstName: true, lastName: true, email: true, status: true, isPlatformAdmin: true },
    });
    for (const u of techUsers) {
      if (u.isPlatformAdmin) continue;
      const { scopes, inactive } = await this.techAccess.resolve(u.id, now);
      const scope = scopes.get(endpoint.customerId ?? '');
      const covers = (ids: string[] | null) => ids === null || ids.includes(endpointId);
      if (scope && covers(scope.endpointIds)) {
        for (const src of scope.sources) {
          if (!covers(src.endpointIds)) continue;
          const hasConnect = src.capabilities.includes(CAP.COMPUTERS_CONNECT);
          push({
            userId: u.id, name: name(u), email: u.email, via: src.via === 'GROUP' ? 'TECHNICIAN_GROUP' : 'TECHNICIAN_DIRECT',
            detail: src.via === 'GROUP' ? `Technician via group "${src.groupName}"` : 'Technician, assigned directly',
            activeNow: u.status === 'ACTIVE' && hasConnect,
            inactiveReason: u.status !== 'ACTIVE' ? 'account disabled' : hasConnect ? undefined : 'assignment does not include "connect"',
            startsAt: src.startsAt?.toISOString() ?? null, expiresAt: src.expiresAt?.toISOString() ?? null, schedule: src.schedule, temporary: src.temporary,
          });
        }
      }
      for (const i of inactive.filter((x) => x.businessId === endpoint.customerId)) {
        if (!covers(i.endpointIds)) continue;
        push({
          userId: u.id, name: name(u), email: u.email, via: i.via === 'GROUP' ? 'TECHNICIAN_GROUP' : 'TECHNICIAN_DIRECT',
          detail: i.via === 'GROUP' ? `Technician via group "${i.groupName}" (not active)` : 'Technician assignment (not active)',
          activeNow: false, inactiveReason: i.inactiveReason.replace(/_/g, ' '),
          startsAt: i.startsAt?.toISOString() ?? null, expiresAt: i.expiresAt?.toISOString() ?? null, schedule: i.schedule, temporary: i.temporary,
        });
      }
    }

    return {
      endpoint: { id: endpoint.id, name: endpoint.name, accessMode: endpoint.accessMode, businessId: ep.customerId },
      reviewedAt: now.toISOString(),
      entries: entries.sort((a, b) => Number(b.activeNow) - Number(a.activeNow) || a.name.localeCompare(b.name)),
      note: 'Removing someone here stops new connections through Rem0te. It does not change a RustDesk password they already saw — rotate the credential for that.',
    };
  }
}
