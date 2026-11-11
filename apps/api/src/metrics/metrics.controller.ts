import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { MetricsService } from './metrics.service';

/**
 * Metric history (0.33): CPU, memory and disk for one computer over a range.
 * computers:view, and the computer must be in scope and visible to the caller
 * (MetricsService.history) — another business's computer is a 404.
 */
@Controller('endpoints')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** `range` = 24h (raw samples) | 7d | 30d | 90d (hourly min / mean / max). Gaps are returned, never filled. */
  @Get(':id/metrics')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async history(@Actor() actor: ActorContext, @Param('id') id: string, @Query('range') range?: string) {
    return { success: true, data: await this.metrics.history(actor, id, range) };
  }
}
