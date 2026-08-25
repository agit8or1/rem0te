import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';

export interface PlatformSettingsDto {
  quickConnectEnabled?: boolean;
  quickConnectWindows?: boolean;
  quickConnectMacos?: boolean;
  quickConnectLinux?: boolean;
}

/**
 * Platform-wide switches owned by the Rem0te operator. Backed by a single row
 * so there is one unambiguous answer to "is Quick Connect on".
 */
@Injectable()
export class PlatformSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Reads the singleton, creating it with safe defaults on first call. */
  async get() {
    const existing = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    if (existing) return existing;
    // Quick Connect ships OFF — the operator turns it on deliberately.
    return this.prisma.platformSettings.create({ data: { id: 'singleton' } });
  }

  async update(actor: ActorContext, dto: PlatformSettingsDto) {
    const before = await this.get();

    const updated = await this.prisma.platformSettings.update({
      where: { id: 'singleton' },
      data: {
        ...(dto.quickConnectEnabled !== undefined ? { quickConnectEnabled: dto.quickConnectEnabled } : {}),
        ...(dto.quickConnectWindows !== undefined ? { quickConnectWindows: dto.quickConnectWindows } : {}),
        ...(dto.quickConnectMacos !== undefined ? { quickConnectMacos: dto.quickConnectMacos } : {}),
        ...(dto.quickConnectLinux !== undefined ? { quickConnectLinux: dto.quickConnectLinux } : {}),
      },
    });

    if (dto.quickConnectEnabled !== undefined && dto.quickConnectEnabled !== before.quickConnectEnabled) {
      await this.audit.log({
        actorId: actor.userId, actorIp: actor.ip,
        action: 'QUICK_CONNECT_SETTING_CHANGED',
        resource: 'platform_settings', resourceId: 'singleton',
        meta: { scope: 'platform', enabled: dto.quickConnectEnabled },
      });
    }

    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'PLATFORM_SETTINGS_UPDATED',
      resource: 'platform_settings', resourceId: 'singleton',
      meta: { fields: Object.keys(dto) },
    });

    return updated;
  }

  /**
   * Which Quick Connect client builds are advertised.
   *
   * Only platforms we actually produce a working, preconfigured build for are
   * listed — an OS toggled on here but without a build would hand someone a
   * download that cannot reach our infrastructure.
   */
  async availableClients(): Promise<{ os: 'windows' | 'macos' | 'linux'; label: string; path: string }[]> {
    const s = await this.get();
    const out: { os: 'windows' | 'macos' | 'linux'; label: string; path: string }[] = [];
    if (s.quickConnectWindows) {
      out.push({ os: 'windows', label: 'Windows', path: '/api/v1/public/quick-connect/download/windows' });
    }
    if (s.quickConnectMacos) {
      out.push({ os: 'macos', label: 'macOS', path: '/api/v1/public/quick-connect/download/macos' });
    }
    if (s.quickConnectLinux) {
      out.push({ os: 'linux', label: 'Linux', path: '/api/v1/public/quick-connect/download/linux' });
    }
    return out;
  }
}
