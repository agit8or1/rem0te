import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { AiTimelineService } from './timeline.service';

/**
 * The device page's AI summary (0.34), requested through ClientSt0r's
 * inference gateway. The service resolves scope first: another business's
 * computer is a 404 here as everywhere else.
 */
@Controller('endpoints')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AiTimelineController {
  constructor(private readonly svc: AiTimelineService) {}

  /** Whether a summary can be requested, why not, and exactly which fields would leave rem0te. */
  @Get(':id/timeline')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async status(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.status(actor, id) };
  }

  /** Ask ClientSt0r for a summary and store it. Also needs integration:ticket_analysis, checked after scope. */
  @Post(':id/timeline/generate')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async generate(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.generate(actor, id) };
  }
}
