import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { spawn } from 'child_process';
import * as os from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { HostMetricsService } from './host-metrics.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly hostMetrics: HostMetricsService,
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

    // Live rates and relay usage, from the sampler. `cpu.percent` is real
    // utilisation; `loadAvg` is kept beside it because they answer different
    // questions and neither substitutes for the other.
    const live = this.hostMetrics.snapshot();

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
        loadAvg: live.cpu.loadAvg,
        count: live.cpu.cores,
        percent: live.cpu.percent,
      },
      network: live.network,
      relay: live.relay,
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
