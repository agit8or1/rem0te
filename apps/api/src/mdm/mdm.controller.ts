import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { MdmService } from './mdm.service';

/**
 * Mobile devices (0.80 Tablet), read-only. Four GETs, each needing
 * `mobile:view`; the service then pins the caller to their own business
 * (§90). There is no POST, PUT or DELETE: no device action, and no way to
 * connect a provider, exists in 0.80.
 */
@Controller('mobile-devices')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MdmController {
  constructor(private readonly mdm: MdmService) {}

  /** Whether a provider is connected for this scope ("requires setup" until one is), and what one needs. */
  @Get('setup')
  @RequireCapability(CAP.MOBILE_VIEW)
  async setup(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.setup(a, q) };
  }

  @Get()
  @RequireCapability(CAP.MOBILE_VIEW)
  async list(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.list(a, q) };
  }

  @Get(':id')
  @RequireCapability(CAP.MOBILE_VIEW)
  async get(@Actor() a: ActorContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.get(a, id, q) };
  }

  /** Command history: provider acceptance and device completion as separate facts. */
  @Get(':id/commands')
  @RequireCapability(CAP.MOBILE_VIEW)
  async commands(@Actor() a: ActorContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.mdm.commands(a, id, q) };
  }
}
