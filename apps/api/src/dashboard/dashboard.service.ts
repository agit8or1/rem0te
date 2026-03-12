import { Injectable } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getTenantStats(tenantId: string) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalEndpoints,
      onlineEndpoints,
      totalCustomers,
      totalUsers,
      totalSessions30d,
      totalSessions7d,
      activeSessions,
      pendingSessions,
      recentSessions,
      recentActivity,
      sessionsByDay,
    ] = await Promise.all([
      this.prisma.endpoint.count({ where: { tenantId, status: 'ACTIVE' } }),
      this.prisma.endpoint.count({ where: { tenantId, isOnline: true, status: 'ACTIVE' } }),
      this.prisma.customer.count({ where: { tenantId, isArchived: false } }),
      this.prisma.user.count({
        where: {
          memberships: { some: { tenantId, isActive: true } },
          status: 'ACTIVE',
        },
      }),
      this.prisma.supportSession.count({ where: { tenantId, createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.supportSession.count({ where: { tenantId, createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.supportSession.count({ where: { tenantId, status: { notIn: [SessionStatus.SESSION_COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELED] } } }),
      this.prisma.supportSession.count({ where: { tenantId, status: SessionStatus.PENDING } }),
      this.prisma.supportSession.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          technician: { select: { id: true, email: true, firstName: true, lastName: true } },
          endpoint: { select: { id: true, name: true, hostname: true } },
        },
      }),
      this.prisma.activityLog.findMany({
        where: { tenantId, createdAt: { gte: sevenDaysAgo } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          actor: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      }),
      // Sessions per day for the last 7 days
      this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
        SELECT DATE("createdAt")::text as date, COUNT(*) as count
        FROM "SupportSession"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" >= ${sevenDaysAgo}
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `,
    ]);

    return {
      endpoints: {
        total: totalEndpoints,
        online: onlineEndpoints,
        offline: totalEndpoints - onlineEndpoints,
        onlinePercent: totalEndpoints > 0 ? Math.round((onlineEndpoints / totalEndpoints) * 100) : 0,
      },
      customers: { total: totalCustomers },
      users: { total: totalUsers },
      sessions: {
        last30Days: totalSessions30d,
        last7Days: totalSessions7d,
        active: activeSessions,
        pending: pendingSessions,
        recent: recentSessions,
      },
      activity: {
        recent: recentActivity,
        sessionsByDay: sessionsByDay.map((r) => ({
          date: r.date,
          count: Number(r.count),
        })),
      },
    };
  }

  async getPlatformStats() {
    const [totalTenants, activeTenants, totalUsers, totalEndpoints, totalSessions] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.endpoint.count({ where: { status: 'ACTIVE' } }),
      this.prisma.supportSession.count(),
    ]);

    return {
      tenants: { total: totalTenants, active: activeTenants },
      users: { total: totalUsers },
      endpoints: { total: totalEndpoints },
      sessions: { total: totalSessions },
    };
  }
}
