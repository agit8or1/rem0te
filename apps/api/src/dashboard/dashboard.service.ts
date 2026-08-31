import { Injectable } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { GeoipService } from '../geoip/geoip.service';
import { CAP } from '../rbac/capabilities';

/**
 * Dashboard counts.
 *
 * A count is still a disclosure — "there are 47 computers" tells a Business
 * User something about a business they may not belong to — so every query
 * here carries the same scope filter as the list pages, and a capability the
 * caller lacks yields null rather than a number.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly geoip: GeoipService,
  ) {}

  async getStats(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);
    const businessFilter = scope ? { customerId: scope } : {};

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const canSeeComputers = this.acl.can(actor, CAP.COMPUTERS_VIEW);
    const canSeeSessions = this.acl.can(actor, CAP.SESSIONS_VIEW);
    const canSeeUsers = this.acl.can(actor, CAP.USERS_VIEW);
    const canSeeAudit = this.acl.can(actor, CAP.AUDIT_VIEW);

    const sessionFilter = {
      ...businessFilter,
      // Without history rights a Business User's numbers cover only their own
      // sessions, matching what the sessions list would show them.
      ...(this.acl.isBusinessOwner(actor) || this.acl.can(actor, CAP.HISTORY_VIEW)
        ? {}
        : { technicianId: actor.userId }),
    };

    const [
      totalEndpoints, onlineEndpoints, totalBusinesses, totalUsers,
      totalSessions30d, totalSessions7d, activeSessions, pendingSessions,
      recentSessions, recentActivity, sessionsByDay,
    ] = await Promise.all([
      canSeeComputers ? this.prisma.endpoint.count({ where: { ...businessFilter, status: 'ACTIVE' } }) : 0,
      canSeeComputers ? this.prisma.endpoint.count({ where: { ...businessFilter, isOnline: true, status: 'ACTIVE' } }) : 0,

      actor.isPlatformAdmin
        ? this.prisma.customer.count({ where: { isArchived: false } })
        : 1,

      canSeeUsers
        ? this.prisma.membership.count({
            where: { ...businessFilter, isActive: true, user: { status: 'ACTIVE' } },
          })
        : 0,

      canSeeSessions ? this.prisma.supportSession.count({ where: { ...sessionFilter, createdAt: { gte: thirtyDaysAgo } } }) : 0,
      canSeeSessions ? this.prisma.supportSession.count({ where: { ...sessionFilter, createdAt: { gte: sevenDaysAgo } } }) : 0,
      canSeeSessions ? this.prisma.supportSession.count({
        where: { ...sessionFilter, status: { notIn: [SessionStatus.SESSION_COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELED] } },
      }) : 0,
      canSeeSessions ? this.prisma.supportSession.count({ where: { ...sessionFilter, status: SessionStatus.PENDING } }) : 0,

      canSeeSessions
        ? this.prisma.supportSession.findMany({
            where: sessionFilter,
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: {
              technician: { select: { id: true, email: true, firstName: true, lastName: true } },
              endpoint: { select: { id: true, name: true, hostname: true } },
              customer: { select: { id: true, name: true } },
            },
          })
        : [],

      canSeeAudit
        ? this.prisma.activityLog.findMany({
            where: { ...businessFilter, createdAt: { gte: sevenDaysAgo } },
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { actor: { select: { id: true, email: true, firstName: true, lastName: true } } },
          })
        : [],

      canSeeSessions
        ? this.sessionsPerDay(scope, sevenDaysAgo)
        : Promise.resolve([] as { date: string; count: number }[]),
    ]);

    return {
      scope: scope ? 'business' : 'platform',
      endpoints: {
        total: totalEndpoints,
        online: onlineEndpoints,
        offline: totalEndpoints - onlineEndpoints,
        onlinePercent: totalEndpoints > 0 ? Math.round((onlineEndpoints / totalEndpoints) * 100) : 0,
      },
      businesses: { total: totalBusinesses },
      users: { total: totalUsers },
      sessions: {
        last30Days: totalSessions30d,
        last7Days: totalSessions7d,
        active: activeSessions,
        pending: pendingSessions,
        recent: recentSessions,
      },
      activity: { recent: recentActivity, sessionsByDay },
    };
  }

  /**
   * Parameterised rather than interpolated — `scope` reaches this from a
   * request, and a raw query is the one place a scope value could stop being
   * a filter and start being SQL.
   */
  private async sessionsPerDay(scope: string | null, since: Date) {
    const rows = scope
      ? await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
          SELECT DATE("createdAt")::text as date, COUNT(*) as count
          FROM "SupportSession"
          WHERE "customerId" = ${scope} AND "createdAt" >= ${since}
          GROUP BY DATE("createdAt") ORDER BY date ASC`
      : await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
          SELECT DATE("createdAt")::text as date, COUNT(*) as count
          FROM "SupportSession"
          WHERE "createdAt" >= ${since}
          GROUP BY DATE("createdAt") ORDER BY date ASC`;

    return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  /** Platform-wide totals. Platform Admin only. */
  async getPlatformStats(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);

    const [totalBusinesses, activeBusinesses, totalUsers, totalEndpoints, unassignedEndpoints, totalSessions, quickConnectSessions] =
      await Promise.all([
        this.prisma.customer.count({ where: { isArchived: false } }),
        this.prisma.customer.count({ where: { isArchived: false, isActive: true } }),
        this.prisma.user.count({ where: { status: 'ACTIVE' } }),
        this.prisma.endpoint.count({ where: { status: 'ACTIVE' } }),
        this.prisma.endpoint.count({ where: { customerId: null } }),
        this.prisma.supportSession.count(),
        this.prisma.supportSession.count({ where: { isAdHoc: true } }),
      ]);

    return {
      businesses: { total: totalBusinesses, active: activeBusinesses },
      users: { total: totalUsers },
      endpoints: { total: totalEndpoints, unassigned: unassignedEndpoints },
      sessions: { total: totalSessions, quickConnect: quickConnectSessions },
    };
  }

  /**
   * Approximate locations of the computers the caller may see, for the
   * dashboard map.
   *
   * Scoped with `endpointVisibilityWhere`, NOT `businessWhere`: a map pin
   * discloses at least as much as a table row, and a Business User must not
   * see pins for ASSIGNED_USERS machines in their business that they have no
   * access to. Without `computers:view` this returns null and the map is not
   * rendered at all, matching how the counts above withhold rather than zero.
   *
   * Raw IP addresses are deliberately not returned. The map needs a location,
   * not an address, and the computers list already shows the address to
   * whoever is entitled to it.
   */
  async getEndpointMap(actor: ActorContext, businessId?: string) {
    if (!this.acl.can(actor, CAP.COMPUTERS_VIEW)) return null;

    const rows = await this.prisma.endpoint.findMany({
      where: { ...this.acl.endpointVisibilityWhere(actor, businessId), status: 'ACTIVE' },
      select: {
        id: true, name: true, hostname: true, ipAddress: true,
        isOnline: true, lastSeenAt: true,
        customer: { select: { id: true, name: true } },
      },
    });

    type Point = {
      key: string; lat: number; lon: number;
      city: string | null; region: string | null; country: string; countryName: string | null;
      accuracy: 'city' | 'country';
      total: number; online: number;
      endpoints: { id: string; name: string; isOnline: boolean; businessName: string | null }[];
    };

    const points = new Map<string, Point>();
    let unlocatable = 0;

    for (const r of rows) {
      const geo = this.geoip.lookup(r.ipAddress);
      if (!geo) {
        // Private address, no address yet, or absent from the database. Counted
        // and reported rather than dropped, so the map is never quietly
        // narrower than the fleet it claims to show.
        unlocatable += 1;
        continue;
      }
      // Group by resolved place, not by coordinate, so every machine behind one
      // office NAT lands on a single marker instead of stacking invisibly.
      const key = `${geo.country}|${geo.region ?? ''}|${geo.city ?? ''}`;
      let p = points.get(key);
      if (!p) {
        p = {
          key, lat: geo.lat, lon: geo.lon,
          city: geo.city, region: geo.region, country: geo.country,
          countryName: geo.countryName,
          accuracy: geo.accuracy, total: 0, online: 0, endpoints: [],
        };
        points.set(key, p);
      }
      p.total += 1;
      if (r.isOnline) p.online += 1;
      p.endpoints.push({
        id: r.id,
        name: r.name,
        isOnline: r.isOnline,
        businessName: r.customer?.name ?? null,
      });
    }

    const list = [...points.values()].sort((a, b) => b.total - a.total);
    return {
      points: list,
      located: rows.length - unlocatable,
      unlocatable,
      total: rows.length,
      // Country-level points sit on a country centroid, not on the machine.
      // The client labels them so nobody reads a pin in Kansas as an address.
      approximate: list.filter((p) => p.accuracy === 'country').length,
    };
  }
}
