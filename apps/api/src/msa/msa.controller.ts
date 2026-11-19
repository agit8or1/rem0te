import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { MsaService } from './msa.service';
import { PRODUCIBLE_STATES, type ProducibleState } from './readiness';

const ID = /^[a-z0-9]{20,40}$/;

/**
 * Managed Secure Access readiness (0.69). Read-only, computers:view, and
 * only computers this person can see (endpointVisibilityWhere; the per-id
 * route through assertEndpointInScope as well). There is no route that
 * changes a computer's mode: Managed Secure Access is not built yet.
 */
@Controller('msa')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MsaController {
  constructor(private readonly svc: MsaService) {}

  @Get('readiness')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async fleet(@Actor() actor: ActorContext, @Query('businessId') businessId?: string, @Query('state') state?: string) {
    const st = (PRODUCIBLE_STATES as readonly string[]).includes(state ?? '') ? (state as ProducibleState) : null;
    return { success: true, data: await this.svc.fleet(actor, businessId && ID.test(businessId) ? businessId : null, st) };
  }

  @Get('readiness/:endpointId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async one(@Actor() actor: ActorContext, @Param('endpointId') endpointId: string) {
    if (!ID.test(endpointId)) throw new NotFoundException('Computer not found');
    const r = await this.svc.forEndpoint(actor, endpointId);
    if (!r) throw new NotFoundException('Computer not found');
    return { success: true, data: r };
  }
}
