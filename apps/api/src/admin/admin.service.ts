import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { spawn } from 'child_process';
import * as os from 'os';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(user: JwtPayload) {
    if (!user.isPlatformAdmin) {
      throw new ForbiddenException('Platform admin access required');
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

  async getUnassignedDevices() {
    return this.prisma.endpoint.findMany({
      where: { tenantId: null },
      include: {
        rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async assignDevice(id: string, tenantId: string) {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id, tenantId: null },
      include: { rustdeskNode: true },
    });
    if (!endpoint) throw new NotFoundException(`Unassigned endpoint ${id} not found`);

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const updated = await this.prisma.endpoint.update({
      where: { id },
      data: { tenantId, status: 'ACTIVE' },
    });

    if (endpoint.rustdeskNode) {
      await this.prisma.rustdeskNode.update({
        where: { id: endpoint.rustdeskNode.id },
        data: { tenantId },
      });
    }

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
