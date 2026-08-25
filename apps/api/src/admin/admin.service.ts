import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { spawn } from 'child_process';
import * as os from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  async getStatus(actor: ActorContext) {
    if (!actor.isPlatformAdmin) {
      throw new ForbiddenException('Platform Admin access required');
    }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    const [disk, services] = await Promise.all([
      this.getDiskUsage(),
      this.getServiceStatuses(),
    ]);

    return {
      uptime: Math.floor(os.uptime()),
      platform: `${os.type()} ${os.release()}`,
      nodeVersion: process.version,
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percent: memPercent,
      },
      cpu: {
        loadAvg: os.loadavg() as [number, number, number],
        count: os.cpus().length,
      },
      disk,
      services,
    };
  }

  /**
   * Computers that have checked in but do not belong to a business yet —
   * either they enrolled without a business-bound claim token, or their
   * business was deleted out from under them.
   */
  async getUnassignedDevices() {
    return this.prisma.endpoint.findMany({
      where: { OR: [{ tenantId: null }, { customerId: null }] },
      include: {
        rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Move an unassigned device into a business. Platform Admin only. */
  async assignDevice(actor: ActorContext, id: string, businessId: string) {
    this.acl.assertPlatformAdmin(actor);

    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id, OR: [{ tenantId: null }, { customerId: null }] },
      include: { rustdeskNode: true },
    });
    if (!endpoint) throw new NotFoundException('That computer is not unassigned');

    const business = await this.prisma.customer.findUnique({
      where: { id: businessId },
      select: { id: true, tenantId: true, name: true, isArchived: true },
    });
    if (!business || business.isArchived) throw new NotFoundException('Business not found');

    const updated = await this.prisma.endpoint.update({
      where: { id },
      data: { tenantId: business.tenantId, customerId: business.id, status: 'ACTIVE' },
    });

    if (endpoint.rustdeskNode) {
      await this.prisma.rustdeskNode.update({
        where: { id: endpoint.rustdeskNode.id },
        data: { tenantId: business.tenantId },
      });
    }

    await this.audit.log({
      tenantId: business.tenantId, customerId: business.id,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_UPDATED', resource: 'endpoint', resourceId: id,
      meta: { assignedToBusiness: business.name },
    });

    return updated;
  }

  /**
   * Search across businesses, users and computers.
   *
   * The scope filter is the same one every other read uses: a Platform Admin
   * searches globally, everyone else searches inside their own business only.
   * There is no code path that returns a row from another business.
   */
  async search(actor: ActorContext, query: string) {
    const q = query.trim();
    if (q.length < 2) {
      return { businesses: [], users: [], computers: [], query: q };
    }

    const scope = this.acl.resolveScope(actor);
    const like = { contains: q, mode: 'insensitive' as const };
    const canSeeUsers = actor.isPlatformAdmin || this.acl.can(actor, CAP.USERS_VIEW);
    const canSeeComputers = actor.isPlatformAdmin || this.acl.can(actor, CAP.COMPUTERS_VIEW);

    const [businesses, users, computers] = await Promise.all([
      this.prisma.customer.findMany({
        where: {
          isArchived: false,
          ...(scope ? { id: scope } : {}),
          OR: [{ name: like }, { code: like }, { email: like }, { city: like }],
        },
        select: { id: true, name: true, code: true, city: true, isActive: true },
        take: 10,
      }),

      canSeeUsers
        ? this.prisma.membership.findMany({
            where: {
              ...(scope ? { customerId: scope } : {}),
              user: { OR: [{ email: like }, { firstName: like }, { lastName: like }] },
            },
            select: {
              user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
              customer: { select: { id: true, name: true } },
              role: { select: { type: true } },
            },
            take: 10,
          })
        : Promise.resolve([]),

      canSeeComputers
        ? this.prisma.endpoint.findMany({
            where: {
              ...(scope ? { customerId: scope } : {}),
              OR: [
                { name: like },
                { hostname: like },
                { ipAddress: like },
                { platform: like },
                { osVersion: like },
                { aliases: { some: { alias: like } } },
                { rustdeskNode: { rustdeskId: like } },
              ],
            },
            select: {
              id: true, name: true, hostname: true, platform: true, osVersion: true,
              ipAddress: true, status: true, isOnline: true,
              customer: { select: { id: true, name: true } },
              rustdeskNode: { select: { rustdeskId: true } },
            },
            take: 20,
          })
        : Promise.resolve([]),
    ]);

    return {
      query: q,
      scope: scope ? 'business' : 'platform',
      businesses,
      users: users.map((m) => ({ ...m.user, business: m.customer, level: m.role.type })),
      computers,
    };
  }

  private runAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      let out = '';
      const proc = spawn(cmd, args, { timeout: timeoutMs });
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', () => resolve(out.trim()));
      proc.on('error', () => resolve(''));
    });
  }

  private async getDiskUsage() {
    try {
      const out = await this.runAsync('df', ['-B1', '/'], 5000);
      const parts = out.split('\n').slice(-1)[0].trim().split(/\s+/);
      const total = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      const free = parseInt(parts[3], 10);
      const percent = Math.round((used / total) * 100);
      return { total, used, free, percent };
    } catch {
      return { total: 0, used: 0, free: 0, percent: 0 };
    }
  }

  private async getServiceStatuses() {
    const services = [
      { name: 'Reboot Remote API', unit: 'reboot-remote-api' },
      { name: 'Reboot Remote Web', unit: 'reboot-remote-web' },
      { name: 'Caddy (Proxy)', unit: 'caddy' },
      { name: 'PostgreSQL', unit: 'postgresql' },
      { name: 'Redis', unit: 'redis-server' },
      { name: 'RustDesk (hbbs)', unit: 'rustdesk-hbbs' },
      { name: 'RustDesk (hbbr)', unit: 'rustdesk-hbbr' },
    ];

    return Promise.all(
      services.map(async ({ name, unit }) => {
        const [statusOut, pidOut] = await Promise.all([
          this.runAsync('systemctl', ['is-active', unit], 3000),
          this.runAsync('systemctl', ['show', unit, '--property=MainPID', '--value'], 2000),
        ]);

        const status = (['active', 'failed', 'inactive'].includes(statusOut) ? statusOut : 'unknown') as
          'active' | 'inactive' | 'failed' | 'unknown';

        const p = parseInt(pidOut, 10);
        const pid = p > 0 ? p : undefined;

        return { name, unit, status, pid };
      }),
    );
  }
}
