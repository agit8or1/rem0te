import { Injectable, ForbiddenException } from '@nestjs/common';
import { execSync } from 'child_process';
import * as os from 'os';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Injectable()
export class AdminService {
  getStatus(user: JwtPayload) {
    if (!user.isPlatformAdmin) {
      throw new ForbiddenException('Platform admin access required');
    }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    const disk = this.getDiskUsage();
    const services = this.getServiceStatuses();

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

  private getDiskUsage() {
    try {
      const out = execSync("df -B1 / | tail -1", { encoding: 'utf8', timeout: 5000 });
      const parts = out.trim().split(/\s+/);
      const total = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      const free = parseInt(parts[3], 10);
      const percent = Math.round((used / total) * 100);
      return { total, used, free, percent };
    } catch {
      return { total: 0, used: 0, free: 0, percent: 0 };
    }
  }

  private getServiceStatuses() {
    const services = [
      { name: 'Reboot Remote API', unit: 'reboot-remote-api' },
      { name: 'Reboot Remote Web', unit: 'reboot-remote-web' },
      { name: 'Caddy (Proxy)', unit: 'caddy' },
      { name: 'PostgreSQL', unit: 'postgresql' },
      { name: 'Redis', unit: 'redis-server' },
      { name: 'RustDesk (hbbs)', unit: 'rustdesk-hbbs' },
      { name: 'RustDesk (hbbr)', unit: 'rustdesk-hbbr' },
    ];

    return services.map(({ name, unit }) => {
      try {
        const out = execSync(
          `systemctl is-active ${unit} 2>/dev/null || true`,
          { encoding: 'utf8', timeout: 3000 },
        ).trim();

        let pid: number | undefined;
        try {
          const pidOut = execSync(
            `systemctl show ${unit} --property=MainPID --value 2>/dev/null`,
            { encoding: 'utf8', timeout: 2000 },
          ).trim();
          const p = parseInt(pidOut, 10);
          if (p > 0) pid = p;
        } catch { /* ignore */ }

        return {
          name,
          unit,
          status: (out === 'active' ? 'active' : out === 'failed' ? 'failed' : out === 'inactive' ? 'inactive' : 'unknown') as
            'active' | 'inactive' | 'failed' | 'unknown',
          pid,
        };
      } catch {
        return { name, unit, status: 'unknown' as const };
      }
    });
  }
}
