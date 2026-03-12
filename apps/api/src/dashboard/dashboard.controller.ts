import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermissions('dashboard:read')
  async getStats(@CurrentUser() user: JwtPayload) {
    if (user.isPlatformAdmin && !user.tenantId) {
      const stats = await this.dashboard.getPlatformStats();
      return { success: true, data: stats };
    }

    if (!user.tenantId) return { success: false, message: 'No tenant context' };

    const stats = await this.dashboard.getTenantStats(user.tenantId);
    return { success: true, data: stats };
  }

  @Get('platform')
  @RequirePermissions('platform:read')
  async getPlatformStats() {
    const stats = await this.dashboard.getPlatformStats();
    return { success: true, data: stats };
  }
}
