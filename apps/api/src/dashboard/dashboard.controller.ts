import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Counts for whatever the caller can see. Ungated: the service returns
   * zeroes for anything the caller lacks the capability to view, so the page
   * renders for a Business User with minimal permissions instead of 403-ing.
   */
  @Get()
  async getStats(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.dashboard.getStats(actor, businessId) };
  }

  /**
   * Locations for the dashboard map. Ungated for the same reason as the counts:
   * the service returns null without `computers:view`, so a Business User with
   * minimal permissions gets a dashboard without a map rather than a 403.
   */
  @Get('map')
  async getMap(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.dashboard.getEndpointMap(actor, businessId) };
  }

  @Get('platform')
  async getPlatformStats(@Actor() actor: ActorContext) {
    return { success: true, data: await this.dashboard.getPlatformStats(actor) };
  }
}
